/**
 * The request mix — SPEC.md §4, §5, §6.
 *
 * Deliberately shares nothing with the application. The harness must be able to drive any
 * implementation of the specification, so it speaks HTTP and canonical paths only.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const TIERS = ['standard', 'silver', 'gold', 'platinum'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'];

/**
 * Sample ids from the committed dataset rather than inventing them, so every request hits a
 * record that exists. Reads a bounded prefix: the harness must not hold the dataset in
 * memory alongside the target it is measuring.
 */
export async function sampleIds(datasetDir, table, field, limit) {
	const ids = [];
	const stream = createInterface({
		input: createReadStream(join(datasetDir, `${table}.ndjson`)),
		crlfDelay: Infinity,
	});
	for await (const line of stream) {
		if (!line) continue;
		ids.push(JSON.parse(line)[field]);
		if (ids.length >= limit) break;
	}
	stream.close();
	return ids;
}

/**
 * Build the request plan.
 *
 * `quoteShare` is the fraction of requests hitting the uncacheable quote endpoint. The
 * remainder hit the product aggregate, which is where a separated stack's cache earns its
 * keep — so this ratio directly controls how much of the result is cache behaviour versus
 * fan-out cost, and it is recorded with every run.
 */
export function makeRequestFactory({ baseUrl, cartIds, productIds, quoteShare = 0.5, seed = 1 }) {
	// The harness has its own deterministic stream so two runs issue the same request
	// sequence. A run that cannot be repeated cannot be diffed.
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	return function nextRequest() {
		if (next() < quoteShare) {
			const id = cartIds[Math.floor(next() * cartIds.length)];
			return { kind: 'quote', method: 'POST', url: `${baseUrl}/cart/${id}/quote` };
		}
		const id = productIds[Math.floor(next() * productIds.length)];
		const tier = TIERS[Math.floor(next() * TIERS.length)];
		const region = REGIONS[Math.floor(next() * REGIONS.length)];
		return { kind: 'product', method: 'GET', url: `${baseUrl}/product/${id}?tier=${tier}&region=${region}` };
	};
}

/**
 * The background write stream — SPEC.md §6.
 *
 * Not an endpoint under test. It exists so caches have to stay coherent with their source
 * of truth: a read-only workload lets a cache fill once and never invalidate, which is not
 * a cache any real store operates.
 */
export function makeWriterFactory({ opsUrl, skus, seed = 7 }) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return function nextWrite() {
		const sku = skus[Math.floor(next() * skus.length)];
		// Alternate price and inventory writes; both are in the read path's working set.
		if (next() < 0.5) {
			return {
				operation: 'update', database: 'data', table: 'Variant',
				records: [{ sku, basePrice: 500 + Math.floor(next() * 40000) }],
			};
		}
		return {
			operation: 'update', database: 'data', table: 'Inventory',
			records: [{ id: `${sku}:loc-us-east-0`, onHand: Math.floor(next() * 400) }],
		};
	};
}
