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

/**
 * Locations are few and static; resolving them per request would measure nothing useful.
 *
 * The cached value is the PROMISE, not the Map. Caching the Map meant assigning an empty one
 * before the `for await` that fills it, so any request arriving during the first
 * `Location.search` saw a truthy-but-empty Map and got `availability: 0` for every variant —
 * a 200 OK with silently wrong data, hit reliably on every cold start in every worker thread
 * because the harness opens its warm-up at full rate with no ramp. A rejected build clears
 * the cache so the next request retries rather than inheriting a permanently broken one.
 */
let locationsByRegion = null;
function loadLocations() {
	if (!locationsByRegion) {
		locationsByRegion = (async () => {
			const byRegion = new Map();
			for await (const location of Location.search({})) {
				if (!byRegion.has(location.region)) byRegion.set(location.region, []);
				byRegion.get(location.region).push(location);
			}
			for (const list of byRegion.values()) list.sort((a, b) => a.priority - b.priority);
			return byRegion;
		})().catch((error) => {
			locationsByRegion = null;
			throw error;
		});
	}
	return locationsByRegion;
}

async function regionLocations(region) {
	return (await loadLocations()).get(region) ?? [];
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

		// Wave: inventory per variant per location in the requested region, and related
		// products. These are issued TOGETHER: related ids come from the product row already
		// read, so they do not depend on inventory. Awaiting inventory first serialized two
		// independent waves and made the implementation slower than Harper actually is.
		const availability = {};
		const resolvedPrice = {};
		const [, related] = await Promise.all([
			Promise.all(
				variants.map(async (variant) => {
					resolvedPrice[variant.sku] = resolveUnitPrice(variant.basePrice, tier);
					const rows = await Promise.all(locationIds.map((id) => Inventory.get(`${variant.sku}:${id}`)));
					availability[variant.sku] = rows.reduce((sum, r) => sum + (r?.onHand ?? 0), 0);
				})
			),
			Promise.all((row.relatedProductIds ?? []).map((id) => Product.get(id))).then((rows) => rows.filter(Boolean)),
		]);

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
