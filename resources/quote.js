/**
 * POST /cart/:id/quote — the primary endpoint under test. SPEC.md#post-cartidquote.
 *
 * Four to five dependent waves, 60-150 record reads, real pricing logic. Every response is
 * unique to its cart, so no implementation can win here by caching a response (QUOTE-001).
 * Entity caches still do their normal job, which is the job real deployments give them.
 *
 * The dependency structure IS the measurement: a read waits for the data that names its key,
 * and for nothing else. Each read goes out as soon as its key is known, so the chain
 * cart → variants → products → promotions sets the latency, with customer → inventory beside it.
 */
import { Resource, tables } from 'harper';
import { lookupTable } from './lib/lookup.js';
import { candidateConditions } from './lib/promotion-index.js';
import { countCandidates, countNestedReads, countReads, settled, waveEntries, waveRecorder, waveStart } from './lib/timing.js';
import { evaluatePromotions, isEligible, resolveShipping, resolveTax, resolveUnitPrice } from './lib/pricing.js';

const { Cart, Customer, Product, Variant, Inventory, Location, Promotion, Rate } = tables;

// Locations and rates are small lookup tables, memoized per worker and bounded by expiry
// (lib/lookup.js). Promotions are NOT cached this way — they are part of the measured fan-out.
const loadStatic = lookupTable(async () => {
	const locations = [];
	for await (const row of Location.search({})) locations.push(row);
	locations.sort((a, b) => a.priority - b.priority);
	const rates = [];
	for await (const row of Rate.search({})) rates.push(row);
	// Sorted: resolveShipping/resolveTax return the FIRST matching row, and a scan's order is
	// not guaranteed across restarts or replicas. Unsorted, a cart at a weight-band boundary
	// could price differently on two nodes holding identical data — a QUOTE-008 violation
	// that would look like a caching bug.
	rates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { locations, rates };
});

export class quote extends Resource {
	static path = '/cart/:id/quote';

	allowCreate() {
		return true;
	}

	async post() {
		const started = process.hrtime.bigint();
		// Phase accounting — OBS-001 requires data access and compute to be separable, not just
		// a total. Without it a result cannot say whether an advantage is in the datastore or
		// in the application, which is most of what the comparison is for.
		let dataNs = 0n;
		const timed = async (fn) => {
			const t0 = process.hrtime.bigint();
			try {
				return await fn();
			} finally {
				dataNs += process.hrtime.bigint() - t0;
			}
		};
		const waves = waveRecorder();
		const target = this.getId ? { id: this.getId() } : this;
		const cartId = target.id ?? this.id;

		// --- wave 1: the cart -------------------------------------------------------------
		const cart = await timed(() => settled(waves, 'cart', waveStart(waves), Cart.get(cartId)));
		if (!cart) {
			const error = new Error('cart not found');
			error.statusCode = 404;
			throw error;
		}

		// --- waves 2-4, overlapped ----------------------------------------------------------
		// Every read a wave can issue goes out at once, and each wave starts the moment the data
		// it depends on arrives rather than when the previous wave finishes:
		//   - the customer and every line's variant, straight from the cart;
		//   - inventory, as soon as the customer names the region (the cart already names the
		//     SKUs), alongside the product reads;
		//   - each distinct product, as soon as the variants name them;
		//   - promotions, as soon as the customer's tier and the products' categories are known.
		// The dependency chain is cart → variants → products → promotions; customer → inventory
		// runs beside it. Reads in a wave that fail are checked below in the original order.
		const skus = [...new Set(cart.lines.map((line) => line.sku))];
		const [{ locations, rates }, customer, variantBySku, productById, inventoryBySku, candidateRows] = await timed(() => {
			const statics = settled(waves, 'lookups', waveStart(waves), loadStatic());
			const customerRead = settled(waves, 'customer', waveStart(waves), Customer.get(cart.customerId));
			const variantsRead = settled(waves, 'variants', waveStart(waves), Promise.all(skus.map((sku) => Variant.get(sku))), countReads).then(
				(variants) => new Map(skus.map((sku, i) => [sku, variants[i]]))
			);
			const inventoryRead = Promise.all([customerRead, statics]).then(([customer, { locations }]) => {
				if (!customer) return null;
				const regionLocations = locations.filter((l) => l.region === customer.region);
				return settled(
					waves,
					'inventory',
					waveStart(waves),
					Promise.all(skus.map((sku) => Promise.all(regionLocations.map((l) => Inventory.get(`${sku}:${l.id}`))))),
					countNestedReads
				).then((rows) => new Map(skus.map((sku, i) => [sku, rows[i]])));
			});
			const productsRead = variantsRead.then((variantBySku) => {
				const productIds = [...new Set([...variantBySku.values()].filter(Boolean).map((variant) => variant.productId))];
				return settled(waves, 'products', waveStart(waves), Promise.all(productIds.map((id) => Product.get(id))), countReads).then(
					(products) => new Map(productIds.map((id, i) => [id, products[i]]))
				);
			});
			const promotionsRead = Promise.all([customerRead, productsRead]).then(([customer, productById]) => {
				if (!customer) return null;
				const categoryIds = [...new Set([...productById.values()].filter(Boolean).flatMap((product) => product.categoryIds ?? []))];
				return settled(waves, 'promotions', waveStart(waves), collectPromotions(customer.tier, categoryIds, skus), countCandidates);
			});
			return Promise.all([statics, customerRead, variantsRead, productsRead, inventoryRead, promotionsRead]);
		});

		const resolved = cart.lines.map((line) => {
			const variant = variantBySku.get(line.sku) ?? null;
			return { line, variant, product: variant ? (productById.get(variant.productId) ?? null) : null };
		});
		const unknown = resolved.find((r) => !r.variant || !r.product);
		if (unknown) {
			// An unknown sku fails the quote; it is not silently dropped (QUOTE-002).
			const error = new Error(`unknown sku: ${unknown.line.sku}`);
			error.statusCode = 400;
			throw error;
		}
		if (!customer) {
			const error = new Error('customer not found');
			error.statusCode = 400;
			throw error;
		}

		const regionLocations = locations.filter((l) => l.region === customer.region);

		// Availability per line, against the inventory read above, in location priority order.
		for (const entry of resolved) {
			const rows = inventoryBySku.get(entry.line.sku);
			// Honour location priority: consume from the highest-priority location first.
			let remaining = entry.line.quantity;
			const allocation = [];
			for (let i = 0; i < rows.length && remaining > 0; i++) {
				const onHand = rows[i]?.onHand ?? 0;
				if (onHand <= 0) continue;
				const take = Math.min(onHand, remaining);
				allocation.push({ locationId: regionLocations[i].id, quantity: take });
				remaining -= take;
			}
			entry.allocation = allocation;
			entry.shortfall = remaining;
		}

		// --- pricing: eligible promotions, read above, evaluated in the normative order ----
		const lines = resolved.map((entry) => ({
			sku: entry.line.sku,
			quantity: entry.line.quantity,
			unitPrice: resolveUnitPrice(entry.variant.basePrice, customer.tier),
			categoryIds: entry.product.categoryIds ?? [],
		}));
		const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

		const candidates = [];
		for (const line of lines) {
			for (const promotion of candidateRows) {
				if (isEligible(promotion, { tier: customer.tier, sku: line.sku, categoryIds: line.categoryIds })) {
					candidates.push({ sku: line.sku, promotion });
				}
			}
		}

		const { discountTotal, perLine } = evaluatePromotions({ lines, candidates, subtotal });

		// --- wave 5: shipping by region and weight, tax by jurisdiction -------------------
		const totalWeight = resolved.reduce((sum, e) => sum + (e.variant.weight ?? 0) * e.line.quantity, 0);
		const shipping = resolveShipping(rates, customer.region, totalWeight);
		const tax = resolveTax(rates, customer.taxJurisdiction, Math.max(0, subtotal - discountTotal));

		const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
		const dataMs = Number(dataNs) / 1e6;
		this.getContext()?.responseHeaders?.set(
			'Server-Timing',
			// The quote is deliberately not response-cacheable (QUOTE-001), so its cache status
			// is always `miss` — stated rather than omitted, so a run record can tell "not
			// cached" apart from "not instrumented".
			`cache;desc=miss, data;dur=${dataMs.toFixed(2)}, compute;dur=${Math.max(0, totalMs - dataMs).toFixed(2)}, total;dur=${totalMs.toFixed(2)}${waveEntries(waves)}`
		);

		return {
			cartId,
			// Echoed so the response is self-verifying: shipping resolves by region and tax by
			// jurisdiction, and without naming them a conformance test can only assert that
			// SOME number came back. A quote nobody can check is the shape of defect this
			// specification exists to prevent.
			tier: customer.tier,
			// Carried, not redeemed — QUOTE-004. Redemption lands with checkout, where it is a
			// contended per-customer write rather than arithmetic on a row already in hand.
			loyaltyBalance: customer.loyaltyBalance ?? 0,
			region: customer.region,
			taxJurisdiction: customer.taxJurisdiction,
			totalWeight,
			lines: lines.map((line, i) => ({
				sku: line.sku,
				quantity: line.quantity,
				unitPrice: line.unitPrice,
				appliedPromotionIds: perLine.get(line.sku) ?? [],
				lineTotal: line.unitPrice * line.quantity,
				shortfall: resolved[i].shortfall,
			})),
			subtotal,
			discountTotal,
			shipping,
			tax,
			grandTotal: subtotal - discountTotal + shipping + tax,
			currency: 'USD',
		};
	}
}

/**
 * Candidate promotions, by indexed probe.
 *
 * This has been wrong three times, and each failure is instructive.
 *
 * First it probed `tiers = <tier>` and `categoryIds = <category>`. An empty eligibility
 * array means "no restriction on this dimension", and an index cannot match an empty array —
 * so a promotion unrestricted on BOTH was unreachable. 14% of the corpus was dead, and it
 * was exactly the globally-applicable 14%.
 *
 * Then it scanned the whole table, which is correct and does not scale: `bench` carries 5,000
 * promotions and that scan ran on every quote.
 *
 * Then the rows carried `tierKeys` / `categoryKeys` — the same values, or `['*']` when
 * unrestricted — probed with one `in` per dimension and ANDed. Correct, and on `bench` still
 * about as slow as the scan: Harper 5.3.2 answers `in` by walking the attribute's whole index
 * (harper#3240), then reads every row the first condition matches to test the second
 * (docs/data-model.md#promotion-eligibility-index).
 *
 * Now the specification defines the candidate set (SPEC 0.3.0): every promotion open to all
 * SKUs whose tiers and categories admit the cart, plus every promotion naming one of the cart's
 * SKUs, whatever its tiers and categories. Campaigns carry one `eligibilityKeys` entry per
 * (tier key, category key) pair — the AND of the two dimensions, computed by the schema and
 * indexed — and the cart asks for the pairs it can match. SKU-scoped promotions are found by
 * `skus`, one equality probe per cart SKU. Every probe is a bounded index range, and their
 * union is exactly the candidate set. `isEligible` still decides each line on all three
 * authoritative arrays.
 *
 * The result is exactly the candidate set, and so a SUPERSET of the eligible set, never a
 * subset — `scripts/verify-promotion-index.mjs` checks both against the dataset.
 */
async function collectPromotions(tier, categoryIds, skus) {
	const rows = [];
	for await (const row of Promotion.search({ operator: 'or', conditions: candidateConditions(tier, categoryIds, skus) })) {
		rows.push(row);
	}
	// Sorted: the order of a union of index probes is not guaranteed, and evaluation order
	// feeds the normative promotion order (QUOTE-008).
	return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
