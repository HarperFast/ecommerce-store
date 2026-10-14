/**
 * The request mix — SPEC.md#post-cartidquote, "GET /product/:id", "Background writes".
 *
 * Deliberately shares nothing with the application. The harness must be able to drive any
 * implementation of the specification, so it speaks HTTP and canonical paths only.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { REGION_WEIGHTS, TIER_WEIGHTS, weightedPick, zipfIndex } from '@ecommerce-store/spec';

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
	// A missing count would silently take every row — 31M inventory ids into a 1 GiB generator.
	if (!Number.isInteger(totalRows) || totalRows <= 0) throw new Error(`${table}: the manifest gives no row count`);
	// The k-th sample is row floor(k * totalRows / limit), so the samples span the whole table.
	// An integer stride of floor(totalRows / limit) filled `limit` samples before the table
	// ended and left the tail unreachable: 37% of `dev` inventory (31,802 rows, stride 1), and
	// the last 10,143 variants and 1,273 inventory rows at `bench`.
	const take = totalRows && totalRows > limit ? limit : Infinity;
	const ids = [];
	const stream = createInterface({
		input: createReadStream(join(datasetDir, `${table}.ndjson`)),
		crlfDelay: Infinity,
	});
	let index = 0;
	let next = 0;
	for await (const line of stream) {
		if (!line) continue;
		if (index++ === next) {
			ids.push(JSON.parse(line)[field]);
			if (ids.length >= take) break;
			next = take === Infinity ? index : Math.floor((ids.length * totalRows) / limit);
		}
	}
	stream.close();
	if (ids.length !== Math.min(limit, totalRows)) {
		throw new Error(`${table}: sampled ${ids.length} ids, expected ${Math.min(limit, totalRows)}; the manifest row count is wrong`);
	}
	return ids;
}

/**
 * The deterministic PRNG the harness uses for its own streams (mulberry32): two runs with the
 * same seed issue the same sequence, so runs can be diffed.
 */
function stream(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Plan the whole background write stream up front: which product each write lands on, whether
 * it is a price or an inventory write, and its draws.
 *
 * WRITE-001 requires writes within the read path's working set, so a write draws its product
 * with the SAME scrambled Zipf the product reads use — the hot writes land on the hot reads,
 * and carts are built from the same products, so quote lines follow too. The stream is
 * deterministic, so planning it first lets the harness load the variants and inventory of only
 * the few thousand products it will write, instead of 6.5M SKUs and 31M inventory ids that
 * would not fit in the generator's 1 GiB. Four draws per write, whichever branch.
 */
export function planWrites({ productCount, total, seed = 7 }) {
	const next = stream(seed);
	const plan = [];
	for (let i = 0; i < total; i++) {
		plan.push({ productIndex: zipfIndex(next(), productCount), priceWrite: next() < 0.5, pick: next(), value: next() });
	}
	return plan;
}

/**
 * The variants of the planned products, and the inventory rows of those variants. One pass
 * over each table; inventory, the largest, is parsed in full only for rows naming a wanted sku.
 */
export async function writeKeys(datasetDir, productIds) {
	const wanted = new Set(productIds);
	const byProduct = new Map([...wanted].map((id) => [id, { skus: [], inventory: [] }]));
	const productOfSku = new Map();
	for await (const line of createInterface({ input: createReadStream(join(datasetDir, 'variant.ndjson')), crlfDelay: Infinity })) {
		if (!line) continue;
		const variant = JSON.parse(line);
		const keys = byProduct.get(variant.productId);
		if (!keys) continue;
		keys.skus.push(variant.sku);
		productOfSku.set(variant.sku, keys);
	}
	const SKU = /"sku":"([^"]+)"/;
	for await (const line of createInterface({ input: createReadStream(join(datasetDir, 'inventory.ndjson')), crlfDelay: Infinity })) {
		const keys = productOfSku.get(SKU.exec(line)?.[1]);
		if (keys) keys.inventory.push(JSON.parse(line).id);
	}
	for (const [id, keys] of byProduct) if (keys.skus.length === 0) throw new Error(`product ${id} has no variants`);
	return {
		byProduct,
		products: byProduct.size,
		skus: productOfSku.size,
		inventory: [...byProduct.values()].reduce((sum, keys) => sum + keys.inventory.length, 0),
	};
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
	const next = stream(seed);

	/**
	 * Keys are drawn from EVERY cart and product, with the scrambled Zipf the dataset was built
	 * against, and tier/region are weighted rather than uniform.
	 *
	 * Uniform draws make a cache that is almost never asked twice; a 20,000-key sample made a
	 * working set that fit in the target's memory, so DATA-004 could not hold. The whole key
	 * space, skewed, gives both a hot set and a cold tail larger than memory.
	 */
	return function nextRequest() {
		if (next() < quoteShare) {
			const id = cartIds[zipfIndex(next(), cartIds.length)];
			return { kind: 'quote', method: 'POST', url: `${baseUrl}/cart/${id}/quote` };
		}
		const id = productIds[zipfIndex(next(), productIds.length)];
		const tier = weightedPick(TIER_WEIGHTS, next());
		const region = weightedPick(REGION_WEIGHTS, next());
		return { kind: 'product', method: 'GET', url: `${baseUrl}/product/${id}?tier=${tier}&region=${region}` };
	};
}

/**
 * The background write stream — SPEC.md#background-writes.
 *
 * Not an endpoint under test. It exists so caches have to stay coherent with their source
 * of truth: a read-only workload lets a cache fill once and never invalidate, which is not
 * a cache any real store operates.
 */
export function makeWriterFactory({ baseUrl, plan, productIds, keys }) {
	let issued = 0;
	/**
	 * Writes go through the APPLICATION, not the operations API.
	 *
	 * A direct table write updates the source of truth and invalidates nothing, so the cache
	 * would only converge on expiry and SPEC.md#background-writes's cache-coherence cost — the thing it exists to
	 * measure — would never be paid. A separated stack's write path has to evict its Redis key
	 * for the same reason; this is the same work on the other architecture.
	 */
	return function nextWrite() {
		const write = plan[issued++ % plan.length];
		const { skus, inventory } = keys.byProduct.get(productIds[write.productIndex]);
		if (write.priceWrite || inventory.length === 0) {
			return {
				url: `${baseUrl}/admin/variant/${encodeURIComponent(skus[Math.floor(write.pick * skus.length)])}`,
				body: { basePrice: 500 + Math.floor(write.value * 40000) },
			};
		}
		// Inventory ids come from the table rather than being synthesized. Synthesizing
		// `${sku}:loc-us-east-0` named a nonexistent record for most SKUs — a SKU is stocked at
		// only some locations — so those writes were skipped, and they never touched three of
		// the four regions the read path reads.
		return {
			url: `${baseUrl}/admin/inventory/${encodeURIComponent(inventory[Math.floor(write.pick * inventory.length)])}`,
			body: { onHand: Math.floor(write.value * 400) },
		};
	};
}
