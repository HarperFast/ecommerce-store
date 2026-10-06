/**
 * The request mix — SPEC.md, "POST /cart/:id/quote", "GET /product/:id", "Background writes".
 *
 * Deliberately shares nothing with the application. The harness must be able to drive any
 * implementation of the specification, so it speaks HTTP and canonical paths only.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { REGION_WEIGHTS, TIER_WEIGHTS, skewedIndex, weightedPick } from '@ecommerce-store/spec';

/**
 * Sample ids SPREAD ACROSS the whole table, not a prefix.
 *
 * This read the first `limit` lines and stopped. Because ids are derived sequentially, "the
 * first 20,000" was literally product-000000 … product-019999 — 1% of the bench catalog. The
 * dataset is deliberately sized so the working set exceeds the container's memory, but the
 * REACHABLE set was a few tens of MB, resident after warm-up. Every target would have
 * reported a near-100% entity-cache hit rate and the comparison would have measured cache
 * lookup rather than architecture, silently defeating the one requirement the methodology is
 * most explicit about (DATA-004).
 *
 * A stride walk costs one full pass over the table at startup — seeding is not measured, and
 * this is setup, not application behaviour. Emitting a committed key-sample alongside the
 * dataset would remove even that; tracked in docs/plan.md.
 */
export async function sampleIds(datasetDir, table, field, limit, totalRows) {
	const stride = totalRows && totalRows > limit ? Math.floor(totalRows / limit) : 1;
	const ids = [];
	const stream = createInterface({
		input: createReadStream(join(datasetDir, `${table}.ndjson`)),
		crlfDelay: Infinity,
	});
	let index = 0;
	for await (const line of stream) {
		if (!line) continue;
		if (index++ % stride === 0) ids.push(JSON.parse(line)[field]);
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

	/**
	 * Keys are drawn SKEWED, from the same distribution the dataset was built against, and
	 * tier/region are weighted rather than uniform.
	 *
	 * Uniform draws over 20,000 products x 4 tiers x 4 regions is a 320,000-key space that a
	 * short run almost never revisits — measured cache hit rate was 2.5%. A cache nobody asks
	 * twice is a cache the benchmark cannot measure, and neither is the coherence cost of
	 * invalidating it.
	 */
	return function nextRequest() {
		if (next() < quoteShare) {
			const id = cartIds[skewedIndex(next(), cartIds.length)];
			return { kind: 'quote', method: 'POST', url: `${baseUrl}/cart/${id}/quote` };
		}
		const id = productIds[skewedIndex(next(), productIds.length)];
		const tier = weightedPick(TIER_WEIGHTS, next());
		const region = weightedPick(REGION_WEIGHTS, next());
		return { kind: 'product', method: 'GET', url: `${baseUrl}/product/${id}?tier=${tier}&region=${region}` };
	};
}

/**
 * The background write stream — SPEC.md, "Background writes".
 *
 * Not an endpoint under test. It exists so caches have to stay coherent with their source
 * of truth: a read-only workload lets a cache fill once and never invalidate, which is not
 * a cache any real store operates.
 */
export function makeWriterFactory({ baseUrl, skus, inventoryIds, seed = 7 }) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	/**
	 * Writes go through the APPLICATION, not the operations API.
	 *
	 * A direct table write updates the source of truth and invalidates nothing, so the cache
	 * would only converge on expiry and "Background writes"'s cache-coherence cost — the thing it exists to
	 * measure — would never be paid. A separated stack's write path has to evict its Redis key
	 * for the same reason; this is the same work on the other architecture.
	 */
	return function nextWrite() {
		// Alternate price and inventory writes; both are in the read path's working set.
		// Writes target the SAME hot set the reads do — WRITE-001 requires the writer to work
		// within the read path's working set. A uniform writer would mostly invalidate cold
		// keys nobody asks for, so coherence would cost nothing and measure nothing.
		if (next() < 0.5) {
			const sku = skus[skewedIndex(next(), skus.length)];
			return {
				url: `${baseUrl}/admin/variant/${encodeURIComponent(sku)}`,
				body: { basePrice: 500 + Math.floor(next() * 40000) },
			};
		}
		// Inventory ids are sampled from the table rather than synthesized. Synthesizing
		// `${sku}:loc-us-east-0` named a nonexistent record for most SKUs — a SKU is stocked at
		// only some locations — so those writes were skipped, and they never touched three of
		// the four regions the read path reads.
		const id = inventoryIds[skewedIndex(next(), inventoryIds.length)];
		return {
			url: `${baseUrl}/admin/inventory/${encodeURIComponent(id)}`,
			body: { onHand: Math.floor(next() * 400) },
		};
	};
}
