/**
 * Assert that the dataset exercises every pricing phase, at the scale given.
 *
 * QUOTE-005 names four promotion kinds, and SPEC.md#promotion-evaluation-order bounds them with a
 * running 60% cap and three stackables per line, but whether a quote ever reaches any of them is
 * a property of the data. Generator 0.5.0 made
 * every `bench` quote stop at an exclusive promotion, so threshold, BOGO, stackable and the cap
 * applied in no `bench` quote while every `dev` check passed. This prices every cart offline
 * with the reference's own pricing engine and fails if the share of carts reaching any phase
 * leaves its band.
 *
 * Candidates are the candidate set SPEC.md#promotions-are-read-per-quote defines, not what any
 * index returns, so this measures the workload, not a lookup (scripts/verify-promotion-index.mjs
 * checks the reference's). On every cart it also checks that the candidate set holds every
 * promotion eligible for each line, judged against the whole table.
 *
 *   node scripts/verify-pricing-phases.mjs --scale dev
 *   node scripts/verify-pricing-phases.mjs --scale bench [--if-present]
 *
 * `bench` is read compressed from dataset/bench, so it needs `git lfs pull`. With
 * `--if-present` a checkout without the LFS objects skips it and says so; the dataset workflow,
 * which pulls them, checks `bench` on every change to the dataset or the generator.
 */
import { createReadStream } from 'node:fs';
import { open as openFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import { isCandidate } from '@ecommerce-store/spec';
import { evaluatePromotions, isEligible, resolveUnitPrice } from '../resources/lib/pricing.js';

/**
 * Share of carts in which each phase produced a discount, as [min, max]. The same bands hold
 * at both scales: `dev` is where the suite runs, and a phase it exercises that `bench` does not
 * is a phase the benchmark does not measure.
 */
export const BANDS = {
	exclusive: [0.05, 0.25],
	threshold: [0.4, 0.8],
	bogo: [0.3, 0.65],
	stackable: [0.6, 0.9],
	cap: [0.05, 0.25],
	stackLimit: [0.3, 0.75],
	skuRestricted: [0.15, 0.5],
};

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const scale = argOf('scale', 'dev');
const dir = resolve(argOf('dataset', join(import.meta.dirname, '..', 'dataset', scale)));
const manifest = JSON.parse(await readFile(join(dir, 'MANIFEST.json'), 'utf8'));
const fileOf = (table) => join(dir, `${table}.ndjson${manifest.compressed ? '.gz' : ''}`);

// An LFS checkout without the objects holds ~130-byte pointer files in place of the archives.
const handle = await openFile(fileOf('promotion'));
const head = (await handle.read(Buffer.alloc(64), 0, 64, 0)).buffer.toString('utf8');
await handle.close();
if (head.startsWith('version https://git-lfs')) {
	const message = `dataset/${scale} holds Git LFS pointers, not the dataset; run \`git lfs pull\` to check it`;
	if (args.includes('--if-present')) {
		console.log(`SKIPPED — ${message}. The dataset workflow checks it on every dataset or generator change.`);
		process.exit(0);
	}
	console.error(`FAIL — ${message}.`);
	process.exit(1);
}

async function* lines(table) {
	const input = manifest.compressed ? createReadStream(fileOf(table)).pipe(createGunzip()) : createReadStream(fileOf(table));
	for await (const line of createInterface({ input, crlfDelay: Infinity })) if (line) yield line;
}
/** Canonical key order puts `id` or `sku` at a fixed place; matching it first skips parsing rows no cart names. */
const keyOf = (line, field) => line.match(new RegExp(`"${field}":"([^"]+)"`))[1];

const promotions = [];
for await (const line of lines('promotion')) promotions.push(JSON.parse(line));
promotions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const carts = [];
const skus = new Set();
const customerIds = new Set();
for await (const line of lines('cart')) {
	const cart = JSON.parse(line);
	carts.push(cart);
	customerIds.add(cart.customerId);
	for (const l of cart.lines) skus.add(l.sku);
}
const tierOf = new Map();
for await (const line of lines('customer')) {
	const id = keyOf(line, 'id');
	if (customerIds.has(id)) tierOf.set(id, JSON.parse(line).tier);
}
const variants = new Map();
const productIds = new Set();
for await (const line of lines('variant')) {
	if (!skus.has(keyOf(line, 'sku'))) continue;
	const variant = JSON.parse(line);
	variants.set(variant.sku, variant);
	productIds.add(variant.productId);
}
const categoriesOf = new Map();
for await (const line of lines('product')) {
	const id = keyOf(line, 'id');
	if (productIds.has(id)) categoriesOf.set(id, JSON.parse(line).categoryIds ?? []);
}

// Both made fast the same way: promotions open to every SKU are filtered once per (tier,
// categories), and one restricted to SKUs is only ever looked up by them.
const anySku = promotions.filter((p) => !p.skus?.length);
const bySku = new Map();
for (const p of promotions) for (const s of p.skus ?? []) bySku.set(s, [...(bySku.get(s) ?? []), p]);
const memo = (fn) => {
	const cache = new Map();
	return (key, ...args) => (cache.has(key) ? cache.get(key) : cache.set(key, fn(...args)).get(key));
};
const anySkuCandidates = memo((tier, categoryIds) => anySku.filter((p) => isCandidate(p, { tier, skus: [], categoryIds })));
const anySkuEligible = memo((tier, categoryIds) => anySku.filter((p) => isEligible(p, { tier, sku: '', categoryIds })));

/** The cart's candidate set, by SPEC.md's definition, sorted by id. */
function candidateSet(tier, skus, categoryIds) {
	const found = new Map(anySkuCandidates(`${tier}|${categoryIds.join(',')}`, tier, categoryIds).map((p) => [p.id, p]));
	for (const s of skus) for (const p of bySku.get(s) ?? []) if (isCandidate(p, { tier, skus, categoryIds })) found.set(p.id, p);
	return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Every promotion in the table eligible for one line, without the candidate set. */
const eligibleIds = (tier, sku, categoryIds) =>
	[...anySkuEligible(`${tier}|${categoryIds.join(',')}`, tier, categoryIds), ...(bySku.get(sku) ?? []).filter((p) => isEligible(p, { tier, sku, categoryIds }))]
		.map((p) => p.id)
		.sort()
		.join();
const missed = [];

const byId = new Map(promotions.map((p) => [p.id, p]));
const reached = Object.fromEntries(Object.keys(BANDS).map((phase) => [phase, 0]));
let discountShare = 0;
for (const cart of carts) {
	const tier = tierOf.get(cart.customerId);
	const priced = cart.lines.map((line) => {
		const variant = variants.get(line.sku);
		return { sku: line.sku, quantity: line.quantity, unitPrice: resolveUnitPrice(variant.basePrice, tier), categoryIds: categoriesOf.get(variant.productId) };
	});
	const subtotal = priced.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
	const cartCategories = [...new Set(priced.flatMap((l) => l.categoryIds))].sort();
	const rows = candidateSet(tier, [...new Set(priced.map((l) => l.sku))], cartCategories);
	const candidates = [];
	for (const line of priced) {
		const eligible = rows.filter((promotion) => isEligible(promotion, { tier, sku: line.sku, categoryIds: line.categoryIds }));
		if (eligible.map((p) => p.id).sort().join() !== eligibleIds(tier, line.sku, line.categoryIds) && missed.length < 5) missed.push(`${cart.id}/${line.sku}`);
		for (const promotion of eligible) candidates.push({ sku: line.sku, promotion });
	}
	const { discountTotal, perLine } = evaluatePromotions({ lines: priced, candidates, subtotal });

	const applied = new Set([...perLine.values()].flat().map((id) => byId.get(id)));
	for (const kind of new Set([...applied].map((p) => p.kind))) reached[kind]++;
	if ([...applied].some((p) => p.skus?.length)) reached.skuRestricted++;
	if ([...perLine.values()].some((ids) => ids.filter((id) => byId.get(id).kind === 'stackable').length === 3)) reached.stackLimit++;
	if (discountTotal > 0 && discountTotal === Math.floor((subtotal * 6000) / 10000)) reached.cap++;
	discountShare += subtotal ? discountTotal / subtotal : 0;
}

const pct = (share) => `${(share * 100).toFixed(1)}%`;
console.log(`pricing phases on ${scale}: generator ${manifest.generatorVersion}, ${carts.length.toLocaleString()} carts, ${promotions.length.toLocaleString()} promotions`);
const failures = [];
for (const [phase, [min, max]] of Object.entries(BANDS)) {
	const share = reached[phase] / carts.length;
	const ok = share >= min && share <= max;
	console.log(`  ${phase.padEnd(13)} ${pct(share).padStart(6)}   band ${pct(min)}-${pct(max)}${ok ? '' : '   OUT OF BAND'}`);
	if (!ok) failures.push(`${phase}: ${pct(share)} of carts, band ${pct(min)}-${pct(max)}`);
}
console.log(`  mean discount ${pct(discountShare / carts.length)} of subtotal`);

if (missed.length) failures.push(`the candidate set missed a promotion eligible for ${missed.join(', ')}`);
if (failures.length) {
	console.error(`\nFAIL — ${failures.length} pricing phase check(s) failed on ${scale}:`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`\nOK — every pricing phase is exercised on ${scale}.`);
