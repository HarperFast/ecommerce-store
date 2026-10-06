/**
 * POST /cart/:id/quote — the primary endpoint under test. SPEC.md, "POST /cart/:id/quote".
 *
 * Four to five dependent waves, 60-150 record reads, real pricing logic. Every response is
 * unique to its cart, so no implementation can win here by caching a response (QUOTE-001).
 * Entity caches still do their normal job, which is the job real deployments give them.
 *
 * The waves are explicit and ordered because the dependency structure IS the measurement:
 * each wave needs the previous wave's result before it can issue its reads.
 */
import { Resource } from 'harper';
import { UNRESTRICTED } from '@ecommerce-store/spec';
import { evaluatePromotions, isEligible, resolveShipping, resolveTax, resolveUnitPrice } from './lib/pricing.js';

const { Cart, Customer, Product, Variant, Inventory, Location, Promotion, Rate } = tables;

// Locations and rates are small, static lookup tables. Resolving them per request would
// measure dictionary loading, not architecture. Promotions are NOT cached this way — they
// are part of the measured fan-out.
let staticTables = null;
async function loadStatic() {
	if (staticTables) return staticTables;
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
	staticTables = { locations, rates };
	return staticTables;
}

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
		const target = this.getId ? { id: this.getId() } : this;
		const cartId = target.id ?? this.id;

		// --- wave 1: the cart -------------------------------------------------------------
		const cart = await timed(() => Cart.get(cartId));
		if (!cart) {
			const error = new Error('cart not found');
			error.statusCode = 404;
			throw error;
		}

		const { locations, rates } = await loadStatic();

		// --- wave 2: product and variant per line, plus the customer ----------------------
		const [customer, resolved] = await timed(() =>
			Promise.all([
				Customer.get(cart.customerId),
				Promise.all(
					cart.lines.map(async (line) => {
						const variant = await Variant.get(line.sku);
						if (!variant) return { line, variant: null, product: null };
						const product = await Product.get(variant.productId);
						return { line, variant, product };
					})
				),
			])
		);

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

		// --- wave 3: inventory per line across fulfillment locations ----------------------
		await timed(() =>
			Promise.all(
			resolved.map(async (entry) => {
				const rows = await Promise.all(regionLocations.map((l) => Inventory.get(`${entry.line.sku}:${l.id}`)));
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
			})
			)
		);

		// --- wave 4: eligible promotions by tier, sku, and category -----------------------
		const lines = resolved.map((entry) => ({
			sku: entry.line.sku,
			quantity: entry.line.quantity,
			unitPrice: resolveUnitPrice(entry.variant.basePrice, customer.tier),
			categoryIds: entry.product.categoryIds ?? [],
		}));
		const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

		const categoryIds = [...new Set(lines.flatMap((l) => l.categoryIds))];
		const candidateRows = await timed(() => collectPromotions(customer.tier, categoryIds));
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
			`cache;desc=miss, data;dur=${dataMs.toFixed(2)}, compute;dur=${Math.max(0, totalMs - dataMs).toFixed(2)}, total;dur=${totalMs.toFixed(2)}`
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
 * This has been wrong twice, in opposite directions, and both failures are instructive.
 *
 * First it probed `tiers = <tier>` and `categoryIds = <category>`. An empty eligibility
 * array means "no restriction on this dimension", and an index cannot match an empty array —
 * so a promotion unrestricted on BOTH was unreachable. 14% of the corpus was dead, and it
 * was exactly the globally-applicable 14%.
 *
 * Then it scanned the whole table, which is correct and does not scale: `bench` carries 5,000
 * promotions and that scan ran on every quote.
 *
 * Now the rows carry `tierKeys` / `categoryKeys` — the same values, or `['*']` when
 * unrestricted — so "applies to everything" is an indexable value like any other. One `in`
 * probe per dimension covers both cases, and the two conditions AND to a superset of the
 * eligible set. `isEligible` still applies the authoritative arrays, including `skus`, which
 * is not indexed because a SKU-restricted promotion is still reachable through its other two
 * dimensions.
 *
 * The result is a SUPERSET, never a subset — that is the property that matters, and
 * `scripts/verify-promotion-index.mjs` checks it against a full scan.
 */
async function collectPromotions(tier, categoryIds) {
	const rows = [];
	for await (const row of Promotion.search({
		conditions: [
			{ attribute: 'tierKeys', comparator: 'in', value: [tier, UNRESTRICTED] },
			{ attribute: 'categoryKeys', comparator: 'in', value: [...categoryIds, UNRESTRICTED] },
		],
	})) {
		rows.push(row);
	}
	// Sorted: the scan order of two ANDed index probes is not guaranteed, and evaluation
	// order feeds the normative promotion order (QUOTE-008).
	return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}