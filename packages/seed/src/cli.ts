/**
 * Generate the dataset artifact — SPEC.md DATA-003, DATA-005.
 *
 *   node --run seed -- --scale dev --out ../../dataset
 *
 * Writes one NDJSON file per table plus MANIFEST.json carrying per-file SHA-256. The
 * artifact is committed; implementations load it and verify the checksum. Nothing
 * re-derives it — see docs/seed-design.md for why.
 */
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { Rng } from './prng.ts';
import {
	SCALES, carts, customers, inventory, locations, products, promotions, rates, variantShape, variants,
} from './generate.ts';
import { ACCESS_SKEW, REGION_WEIGHTS, TIER_WEIGHTS, skewExponent } from '@ecommerce-store/spec';
import { GENERATOR_VERSION, type DatasetManifest, type Table } from './index.ts';

/**
 * Canonical JSON: keys sorted at every level. The checksum is the dataset's identity, so two
 * runs that differ only in key order must not produce different hashes.
 */
function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The checksum is always over the UNCOMPRESSED bytes. That is what dataset identity means —
 * two implementations must agree on the data, not on how it was transported — so a change of
 * compression must never change the contract.
 */
async function writeTable(dir: string, table: Table, rows: Iterable<Record<string, unknown>>, compress: boolean) {
	const hash = createHash('sha256');
	let count = 0;
	const lines = (function* () {
		for (const row of rows) {
			const line = `${canonical(row)}\n`;
			hash.update(line);
			count++;
			yield line;
		}
	})();
	const name = compress ? `${table}.ndjson.gz` : `${table}.ndjson`;
	const stages: any[] = [Readable.from(lines, { objectMode: false })];
	if (compress) stages.push(createGzip({ level: 9 }));
	stages.push(createWriteStream(join(dir, name)));
	await pipeline(stages as [any, ...any[]]);
	return { sha256: hash.digest('hex'), rows: count };
}

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const scaleName = argOf('scale', 'dev');
// The benchmark dataset is committed gzipped — it is large enough that storing it raw is
// hostile to anyone cloning. scripts/prepare-dataset.mjs expands it before a run.
const compress = args.includes('--gzip') || scaleName === 'bench';
const seed = argOf('seed', 'harper-ecommerce-store-v1');
const outDir = resolve(argOf('out', join(import.meta.dirname, '..', '..', '..', 'dataset', scaleName)));

const scale = SCALES[scaleName];
if (!scale) throw new Error(`Unknown scale "${scaleName}". Known: ${Object.keys(SCALES).join(', ')}`);

await mkdir(outDir, { recursive: true });

// ONE Rng, consumed in a fixed order. Each table draws from its own stream so adding a table
// later does not reshuffle the ones before it — a change should be a diff, not a reshuffle.
const shapeRng = new Rng(`${seed}:shape`);
const counts = variantShape(scale, shapeRng);

const started = process.hrtime.bigint();
const files = {} as DatasetManifest['files'];

files.location = await writeTable(outDir, 'location', locations(scale), compress);
files.customer = await writeTable(outDir, 'customer', customers(scale, new Rng(`${seed}:customer`)), compress);
files.product = await writeTable(outDir, 'product', products(scale, counts, new Rng(`${seed}:product`)), compress);
files.variant = await writeTable(outDir, 'variant', variants(scale, counts, new Rng(`${seed}:variant`)), compress);
files.inventory = await writeTable(outDir, 'inventory', inventory(scale, counts, new Rng(`${seed}:inventory`)), compress);
files.promotion = await writeTable(outDir, 'promotion', promotions(scale, new Rng(`${seed}:promotion`)), compress);
files.rate = await writeTable(outDir, 'rate', rates(), compress);
files.cart = await writeTable(outDir, 'cart', carts(scale, counts, new Rng(`${seed}:cart`)), compress);

const manifest: DatasetManifest = {
	specVersion: '0.2.0-draft',
	generatorVersion: GENERATOR_VERSION,
	scale: scaleName,
	seed,
	compressed: compress,
	files,
	distributions: {
		variantsPerProduct: 'long-tailed, 1-20',
		// Declared AND measured. The declared weights were previously published while the
		// generator silently dropped colliding SKUs, so shipped carts were ~13% smaller than
		// the manifest said.
		cartSize: 'long-tailed, 1-25 distinct SKUs; collisions redrawn, not dropped',
		locationsPerSku: '1-6 of 8',
		tier: 'standard 60 / silver 25 / gold 12 / platinum 3',
		outOfStockRate: 0.12,
		// Fully specified: P(index < x*n) = x ** (1/alpha). Both the dataset and the load
		// generator draw from this, so the hot products are the same on both sides.
		accessSkew: {
			form: 'power law over product index',
			headShare: ACCESS_SKEW.headShare,
			headMass: ACCESS_SKEW.headMass,
			alpha: Number(skewExponent().toFixed(6)),
		},
		requestTierWeights: Object.fromEntries(TIER_WEIGHTS),
		requestRegionWeights: Object.fromEntries(REGION_WEIGHTS),
	},
};

await writeFile(join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
const total = Object.values(files).reduce((sum, f) => sum + f.rows, 0);
console.log(`scale ${scaleName} · seed ${seed} · ${total.toLocaleString()} rows in ${elapsed.toFixed(1)}s`);
for (const [table, f] of Object.entries(files)) {
	console.log(`  ${table.padEnd(10)} ${String(f.rows).padStart(9)} rows  ${f.sha256.slice(0, 12)}`);
}
