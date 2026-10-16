/**
 * The write surface — SPEC.md#background-writes.
 *
 * The background writer drives these. It used to write straight to the tables through the
 * operations API, which worked but could never invalidate anything: the cache would only
 * converge on expiry, and Background writes's whole purpose is to make cache coherence a cost the
 * architecture actually pays.
 *
 * Writing through the application is also what a separated stack must do — its write path
 * updates Postgres and then evicts the Redis key. The fan-out below is the Harper side of
 * exactly that comparison.
 *
 * Not an endpoint under test: its own latency is not a headline metric (SPEC.md#background-writes).
 */
import { Resource, getContext, tables, transaction } from 'harper';
import { lookupTable } from './lib/lookup.js';
import { REGIONS, TIERS, viewKey } from './product.js';

const { Variant, Inventory, Location, ProductView } = tables;

/** Region of each fulfillment location: which views an inventory write can change. */
const loadLocationRegions = lookupTable(async () => {
	const map = new Map();
	for await (const location of Location.search({})) map.set(location.id, location.region);
	return map;
});

/**
 * Invalidate the cached views a write can have changed, and only those.
 *
 * A price change moves `resolvedPrice` for every tier, and the view carries the variant
 * itself, so all 4 tiers x 4 regions go. An inventory change moves `availability` for ONE
 * region only, so it takes 4 entries rather than 16 — narrowing the fan-out is the whole
 * game here, and a cache keyed less precisely would have to drop all 16 either way.
 */
async function invalidateViews(productId, region) {
	// Commit the source-of-truth write FIRST, then invalidate in the next transaction.
	//
	// Harper orders writes to a key by transaction timestamp, and a transaction is stamped when
	// it starts, not when it commits. Staged in the write's own transaction, the invalidation
	// carried the write's START time. A view fill that began after that start but read before
	// the commit assembled the old price, was stamped later than the invalidation, and so won:
	// either the invalidation was discarded as older than the cached entry, or the fill
	// replaced the invalidation marker. The stale view then survived until expiry (120 s)
	// against a 1 s FRESH_MS — scripts/verify-coherence.mjs reproduced it.
	//
	// Invalidating after the commit stamps the invalidation after every snapshot that could
	// have read the old row, and a fill stamped before it is discarded instead of cached. A
	// separated stack's cache-aside write has the same shape: commit to Postgres, then evict.
	await getContext().transaction.commit();
	if (!productId) return 0;
	const regions = region ? [region] : REGIONS;
	const keys = [];
	for (const r of regions) for (const tier of TIERS) keys.push(viewKey(productId, tier, r));
	// In a transaction of its own rather than the request's next one: the write has already
	// committed, so a client disconnect or a commit conflict on a hot view key in the request's
	// scope must not cancel the eviction that makes the write visible. Retried, because a
	// conflict with a concurrent fill of the same key is expected on hot products.
	for (let attempt = 1; ; attempt++) {
		try {
			await transaction({}, () => Promise.all(keys.map((key) => ProductView.invalidate(key))));
			return keys.length;
		} catch (error) {
			if (attempt >= 3) throw error;
		}
	}
}

export class adminVariant extends Resource {
	static path = '/admin/variant/:sku';
	static loadAsInstance = false;

	allowCreate() {
		return true;
	}

	async post(target, body) {
		const sku = target?.sku ?? target?.id;
		const basePrice = body?.basePrice;
		if (!Number.isInteger(basePrice) || basePrice < 0) {
			const error = new Error('basePrice must be a non-negative integer in minor units');
			error.statusCode = 400;
			throw error;
		}
		const variant = await Variant.get(sku);
		if (!variant) {
			const error = new Error(`unknown sku: ${sku}`);
			error.statusCode = 404;
			throw error;
		}
		await Variant.patch(sku, { basePrice });
		const invalidated = await invalidateViews(variant.productId, null);
		return { sku, basePrice, invalidated };
	}
}

export class adminInventory extends Resource {
	static path = '/admin/inventory/:id';
	static loadAsInstance = false;

	allowCreate() {
		return true;
	}

	async post(target, body) {
		const id = target?.id;
		const onHand = body?.onHand;
		if (!Number.isInteger(onHand) || onHand < 0) {
			const error = new Error('onHand must be a non-negative integer');
			error.statusCode = 400;
			throw error;
		}
		const row = await Inventory.get(id);
		if (!row) {
			const error = new Error(`unknown inventory record: ${id}`);
			error.statusCode = 404;
			throw error;
		}
		await Inventory.patch(id, { onHand });

		const variant = await Variant.get(row.sku);
		const region = (await loadLocationRegions()).get(row.locationId);
		const invalidated = variant ? await invalidateViews(variant.productId, region) : 0;
		return { id, onHand, region, invalidated };
	}
}
