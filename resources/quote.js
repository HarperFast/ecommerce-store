/**
 * POST /cart/:id/quote — SPEC.md §4. The primary endpoint under test.
 *
 * Four to five dependent waves, 60-150 record reads, real pricing logic. Every response is
 * unique to its cart, so no implementation can win here by caching a response (QUOTE-001).
 * Entity caches still do their normal job, which is the job real deployments give them.
 *
 * The waves are explicit and ordered because the dependency structure IS the measurement:
 * each wave needs the previous wave's result before it can issue its reads.
 */
import { Resource } from 'harper';
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
		const target = this.getId ? { id: this.getId() } : this;
		const cartId = target.id ?? this.id;

		// --- wave 1: the cart -------------------------------------------------------------
		const cart = await Cart.get(cartId);
		if (!cart) {
			const error = new Error('cart not found');
			error.statusCode = 404;
			throw error;
		}

		const { locations, rates } = await loadStatic();

		// --- wave 2: product and variant per line, plus the customer ----------------------
		const [customer, resolved] = await Promise.all([
			Customer.get(cart.customerId),
			Promise.all(
				cart.lines.map(async (line) => {
					const variant = await Variant.get(line.sku);
					if (!variant) return { line, variant: null, product: null };
					const product = await Product.get(variant.productId);
					return { line, variant, product };
				})
			),
		]);

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
		await Promise.all(
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
		);

		// --- wave 4: eligible promotions by tier, sku, and category -----------------------
		const lines = resolved.map((entry) => ({
			sku: entry.line.sku,
			quantity: entry.line.quantity,
			unitPrice: resolveUnitPrice(entry.variant.basePrice, customer.tier),
			categoryIds: entry.product.categoryIds ?? [],
		}));
		const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

		const candidateRows = await collectPromotions();
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

		const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
		this.getContext()?.responseHeaders?.set('Server-Timing', `total;dur=${elapsed.toFixed(2)}`);

		return {
			cartId,
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
 * Candidate promotions.
 *
 * CORRECTNESS FIRST, deliberately. This was two indexed probes — one on `tiers`, one per
 * category — which could never return a promotion that is unrestricted on BOTH dimensions,
 * even though an empty array means "no restriction" and such a promotion is eligible for
 * every line (SPEC.md §4). 14% of the committed promotion corpus was unreachable, and it was
 * exactly the globally-applicable 14%. The probes also inserted rows into a Map in I/O
 * completion order, so `candidateRows` ordering varied between identical requests.
 *
 * An index that can express "matches X or is unrestricted" is the obvious optimization and
 * is tracked in docs/data-model.md. It must preserve completeness, including unrestricted
 * rows, and must return a deterministic order. Until it exists, this scans and sorts: a
 * complete slow answer beats a fast wrong one in a reference implementation.
 */
async function collectPromotions() {
	const rows = [];
	for await (const row of Promotion.search({})) rows.push(row);
	return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
