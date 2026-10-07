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
import { Resource } from 'harper';
import { REGIONS, TIERS, viewKey } from './product.js';

const { Variant, Inventory, Location, ProductView } = tables;

/** Region of a fulfillment location. Few and static, so resolved once. */
let regionOfLocation = null;
function loadLocationRegions() {
	if (!regionOfLocation) {
		regionOfLocation = (async () => {
			const map = new Map();
			for await (const location of Location.search({})) map.set(location.id, location.region);
			return map;
		})().catch((error) => {
			regionOfLocation = null;
			throw error;
		});
	}
	return regionOfLocation;
}

/**
 * Invalidate the cached views a write can have changed, and only those.
 *
 * A price change moves `resolvedPrice` for every tier, and the view carries the variant
 * itself, so all 4 tiers x 4 regions go. An inventory change moves `availability` for ONE
 * region only, so it takes 4 entries rather than 16 — narrowing the fan-out is the whole
 * game here, and a cache keyed less precisely would have to drop all 16 either way.
 */
async function invalidateViews(productId, region) {
	const regions = region ? [region] : REGIONS;
	const keys = [];
	for (const r of regions) for (const tier of TIERS) keys.push(viewKey(productId, tier, r));
	await Promise.all(keys.map((key) => ProductView.invalidate(key)));
	return keys.length;
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
		await Variant.put({ ...variant, basePrice });
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
		await Inventory.put({ ...row, onHand });

		const variant = await Variant.get(row.sku);
		const region = (await loadLocationRegions()).get(row.locationId);
		const invalidated = variant ? await invalidateViews(variant.productId, region) : 0;
		return { id, onHand, region, invalidated };
	}
}
