/**
 * GET /product/:id?tier=&region= — SPEC.md#get-productidtierregion. The read-heavy leg.
 *
 * Fans out: product, its variants, inventory for those variants, then related products.
 * The fan-out is deliberate (DATA-001) — a pre-joined source of truth would remove the reads
 * the benchmark exists to measure.
 *
 * That fan-out runs inside a CACHE resolver, not on every request. `ProductView` is a
 * `@table(expiration)` cache whose `sourcedFrom` resolver below does the assembly; a hit
 * returns without touching any of the eight entities. This is the Harper-native form of what
 * a separated stack does with Redis, and the comparison is about what keeping it coherent
 * costs, not about who remembered to cache (SPEC.md#caching).
 */
import { Resource } from 'harper';
import { resolveUnitPrice } from './lib/pricing.js';

const { Product, Variant, Inventory, Location, ProductView } = tables;

export const TIERS = ['standard', 'silver', 'gold', 'platinum'];
export const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'];

/** The cache key. Every dimension the value varies by is in it — CACHE-003. */
export const viewKey = (productId, tier, region) => `${productId}:${tier}:${region}`;

/**
 * Locations are few and static; resolving them per request would measure nothing useful.
 *
 * The cached value is the PROMISE, not the Map. Caching the Map meant assigning an empty one
 * before the `for await` that fills it, so any request arriving during the first
 * `Location.search` saw a truthy-but-empty Map and got `availability: 0` for every variant.
 * A rejected build clears the cache so the next request retries.
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

/**
 * Assemble one product view. This is the expensive path — the whole point of the cache is
 * that it runs on a miss, not on a request.
 */
async function assemble(productId, tier, region) {
	const row = await Product.get(productId);
	if (!row) return null;

	const locationIds = ((await loadLocations()).get(region) ?? []).map((l) => l.id);

	const variants = [];
	for await (const variant of Variant.search({ conditions: [{ attribute: 'productId', value: productId }] })) {
		variants.push(variant);
	}
	// Sorted: Harper's scan order is not guaranteed, and an unordered variant array would make
	// two identical requests return different bytes from the same data.
	variants.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

	// Inventory per variant per location in the requested region, and related products.
	// Issued together: related ids come from the product row already read, so they do not
	// depend on inventory, and awaiting inventory first serialized two independent waves.
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

/**
 * The cache fill. Harper calls this on a miss or after expiry; the result is stored in
 * `ProductView` and served directly until invalidated or expired.
 */
ProductView.sourcedFrom(
	class extends Resource {
		async get() {
			const [productId, tier, region] = String(this.getId()).split(':');
			const payload = await assemble(productId, tier, region);
			if (!payload) return null;
			return { id: this.getId(), productId, tier, region, payload, assembledAt: Date.now() };
		}
	}
);

export class product extends Resource {
	static path = '/product/:id';

	allowRead() {
		return true;
	}

	async get(target) {
		const started = process.hrtime.bigint();
		const startedAtMs = Date.now();
		const tier = target.get?.('tier') ?? target.tier ?? 'standard';
		const region = target.get?.('region') ?? target.region ?? 'us-east';

		const key = viewKey(target.id, tier, region);
		const cached = await ProductView.get(key);
		const dataMs = Number(process.hrtime.bigint() - started) / 1e6;

		if (!cached?.payload) {
			const error = new Error('product not found');
			error.statusCode = 404;
			throw error;
		}

		// A fill stamps `assembledAt`. An entry assembled before this request began was already
		// resident; one stamped during it was filled by this request. Compared against the
		// request's own start rather than a derived window, so the signal does not depend on
		// how long the read took. Reported per response — OBS-002.
		const hit = cached.assembledAt < startedAtMs;
		const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
		this.getContext()?.responseHeaders?.set(
			'Server-Timing',
			`cache;desc=${hit ? 'hit' : 'miss'}, data;dur=${dataMs.toFixed(2)}, total;dur=${totalMs.toFixed(2)}`
		);
		return cached.payload;
	}
}
