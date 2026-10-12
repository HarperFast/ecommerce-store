/**
 * Cache coherence under concurrency — PDP-003 and WRITE-002 with readers racing writers.
 *
 * The conformance suite proves a write becomes visible when nothing else is happening. A
 * derived cache's classic failure needs company: a fill that read the old row commits after
 * the write's eviction and re-caches the old value, which then survives until expiry. One
 * request at a time never produces it, and a throughput run reports it as a fast 200.
 *
 * This drives concurrent product reads and price writes against a few hot products, stops
 * the writes, waits FRESH_MS, and then requires every tier x region view of those products to
 * carry the last price written for each variant. Stack-neutral: it speaks the specification's
 * product route and the harness's write surface, nothing else.
 *
 *   node scripts/verify-coherence.mjs [--url http://localhost:9926] [--seconds 10]
 *
 * Mutates prices. Run it against a target that will be reloaded or restored afterwards.
 *
 * COVERS: PDP-003 WRITE-002
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { API, productSearchParams } from '@ecommerce-store/spec';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = argOf('url', 'http://localhost:9926');
const SECONDS = Number(argOf('seconds', '10'));
const PRODUCTS = argOf('products', 'product-000001,product-000002,product-000003,product-000004').split(',');
const READERS = Number(argOf('readers', '48'));
const WRITE_INTERVAL_MS = Number(argOf('write-interval', '10'));
const FRESH_MS = 1000;
const TIERS = ['standard', 'silver', 'gold', 'platinum'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'];

const productUrl = (id, tier, region) => `${BASE_URL}${API.product(id)}?${productSearchParams({ tier, region })}`;

async function readView(id, tier, region) {
	const response = await fetch(productUrl(id, tier, region));
	if (!response.ok) throw new Error(`GET ${id} ${tier} ${region}: ${response.status}`);
	return response.json();
}

// The variants under test, read once before anything is written.
const skus = [];
for (const id of PRODUCTS) {
	const view = await readView(id, 'standard', 'us-east');
	for (const variant of view.variants) skus.push(variant.sku);
}
if (!skus.length) throw new Error('the sampled products carry no variants');

/** The last price each sku was successfully written to. Writes per sku are serialized. */
const lastWritten = new Map();
let writes = 0;
let reads = 0;
let readErrors = 0;
const deadline = Date.now() + SECONDS * 1000;

async function writer(sku, offset) {
	let price = 10000 + offset * 1000;
	while (Date.now() < deadline) {
		price += 1;
		const response = await fetch(`${BASE_URL}/admin/variant/${encodeURIComponent(sku)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ basePrice: price }),
		});
		await response.arrayBuffer();
		if (!response.ok) throw new Error(`write ${sku}: ${response.status}`);
		lastWritten.set(sku, price);
		writes++;
		await sleep(WRITE_INTERVAL_MS);
	}
}

async function reader(index) {
	let n = index;
	while (Date.now() < deadline) {
		const id = PRODUCTS[n % PRODUCTS.length];
		const tier = TIERS[(n >> 2) % TIERS.length];
		const region = REGIONS[(n >> 4) % REGIONS.length];
		n += 7;
		try {
			await readView(id, tier, region);
			reads++;
		} catch {
			readErrors++;
		}
	}
}

console.log(`coherence: ${PRODUCTS.length} products, ${skus.length} variants, ${READERS} readers, ${SECONDS}s`);
await Promise.all([
	...skus.map((sku, i) => writer(sku, i)),
	...Array.from({ length: READERS }, (_, i) => reader(i)),
]);

// The budget is FRESH_MS from the last committed write; every write has returned by now.
await sleep(FRESH_MS);

async function staleViews(views) {
	const stale = [];
	let checked = 0;
	for (const [id, tier, region] of views) {
		const view = await readView(id, tier, region);
		for (const variant of view.variants) {
			const expected = lastWritten.get(variant.sku);
			if (expected === undefined) continue;
			checked++;
			if (variant.basePrice !== expected) {
				stale.push({ view: [id, tier, region], detail: `${id} ${tier}/${region} ${variant.sku}: basePrice ${variant.basePrice}, last written ${expected}` });
			}
		}
	}
	return { stale, checked };
}

const allViews = PRODUCTS.flatMap((id) => TIERS.flatMap((tier) => REGIONS.map((region) => [id, tier, region])));
const { stale, checked } = await staleViews(allViews);

console.log(`${writes} writes, ${reads} reads (${readErrors} errors), ${checked} view prices checked after ${FRESH_MS}ms`);
if (stale.length) {
	console.error(`\nFAIL — ${stale.length} view price(s) still stale ${FRESH_MS}ms after the last write:`);
	for (const { detail } of stale.slice(0, 20)) console.error(`  ${detail}`);
	// Distinguishes a slow invalidation from a lost one: a lost one survives until expiry.
	const RECHECK_MS = 10_000;
	await sleep(RECHECK_MS);
	const views = [...new Map(stale.map((s) => [s.view.join(' '), s.view])).values()];
	const again = await staleViews(views);
	console.error(
		again.stale.length
			? `  ${again.stale.length} still stale ${FRESH_MS + RECHECK_MS}ms after the last write: an invalidation was lost, not late`
			: `  all converged by ${FRESH_MS + RECHECK_MS}ms: late, not lost`
	);
	process.exit(1);
}
console.log('OK — every view reflects the last write within FRESH_MS.');
