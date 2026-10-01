/**
 * GET /product/:id?tier=&region= — SPEC.md §5. The read-heavy leg.
 *
 * Fans out: product, its variants, inventory for those variants, then related products.
 * The fan-out is deliberate (DATA-001) — a pre-joined shape would remove the reads the
 * benchmark exists to measure.
 */
import { Resource } from 'harper';
import { resolveUnitPrice } from './lib/pricing.js';

const { Product, Variant, Inventory, Location } = tables;

/** Locations are few and static; resolving them per request would measure nothing useful. */
let locationsByRegion = null;
async function regionLocations(region) {
	if (!locationsByRegion) {
		locationsByRegion = new Map();
		for await (const location of Location.search({})) {
			if (!locationsByRegion.has(location.region)) locationsByRegion.set(location.region, []);
			locationsByRegion.get(location.region).push(location);
		}
		for (const list of locationsByRegion.values()) list.sort((a, b) => a.priority - b.priority);
	}
	return locationsByRegion.get(region) ?? [];
}

export class product extends Resource {
	static path = '/product/:id';

	allowRead() {
		return true;
	}

	async get(target) {
		const started = process.hrtime.bigint();
		const tier = target.get?.('tier') ?? target.tier ?? 'standard';
		const region = target.get?.('region') ?? target.region ?? 'us-east';

		const row = await Product.get(target.id);
		if (!row) return this.notFound();

		const locations = await regionLocations(region);
		const locationIds = locations.map((l) => l.id);

		// Wave: variants for this product.
		const variants = [];
		for await (const variant of Variant.search({ conditions: [{ attribute: 'productId', value: target.id }] })) {
			variants.push(variant);
		}

		// Wave: inventory per variant per location in the requested region. Direct keyed reads
		// rather than a scan — the synthetic `sku:locationId` key exists for exactly this.
		const availability = {};
		const resolvedPrice = {};
		await Promise.all(
			variants.map(async (variant) => {
				resolvedPrice[variant.sku] = resolveUnitPrice(variant.basePrice, tier);
				const rows = await Promise.all(locationIds.map((id) => Inventory.get(`${variant.sku}:${id}`)));
				availability[variant.sku] = rows.reduce((sum, r) => sum + (r?.onHand ?? 0), 0);
			})
		);

		// Wave: related products.
		const related = (await Promise.all((row.relatedProductIds ?? []).map((id) => Product.get(id)))).filter(Boolean);

		const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
		this.getContext()?.responseHeaders?.set('Server-Timing', `total;dur=${elapsed.toFixed(2)}`);

		return {
			product: {
				id: row.id, title: row.title, categoryIds: row.categoryIds,
				weight: row.weight, relatedProductIds: row.relatedProductIds, reviewRollup: row.reviewRollup,
			},
			variants: variants.map((v) => ({
				sku: v.sku, productId: v.productId, options: v.options, basePrice: v.basePrice, weight: v.weight,
			})),
			availability,
			resolvedPrice,
			related: related.map((p) => ({ id: p.id, title: p.title, reviewRollup: p.reviewRollup })),
			tier,
			region,
		};
	}

	notFound() {
		const error = new Error('product not found');
		error.statusCode = 404;
		throw error;
	}
}
