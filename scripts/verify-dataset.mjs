/**
 * Verify the dataset itself, offline.
 *
 * Some requirements are properties of the committed artifact rather than of a running
 * implementation: that it is checksum-verified, deterministically generated and version
 * controlled, that money is integer minor units at rest, and that the eight entities are
 * present and not pre-joined. None of those can be asserted by hitting an endpoint.
 *
 *   node scripts/verify-dataset.mjs --scale dev
 *
 * COVERS: DATA-001 DATA-002 DATA-003 DATA-005
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const scale = argOf('scale', 'dev');
const dir = resolve(argOf('dataset', join(import.meta.dirname, '..', 'dataset', scale)));

const manifest = JSON.parse(await readFile(join(dir, 'MANIFEST.json'), 'utf8'));
const failures = [];

// --- DATA-001: the eight entities are present, and separate ------------------------------
const EXPECTED = ['cart', 'customer', 'product', 'variant', 'inventory', 'location', 'promotion', 'rate'];
const present = Object.keys(manifest.files).sort();
if (EXPECTED.slice().sort().join() !== present.join()) {
	failures.push(`DATA-001: expected exactly [${EXPECTED.sort()}], found [${present}]`);
}

async function* rows(table, limit = Infinity) {
	const gz = manifest.compressed;
	const path = join(dir, `${table}.ndjson${gz ? '.gz' : ''}`);
	const input = gz ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
	let n = 0;
	for await (const line of createInterface({ input, crlfDelay: Infinity })) {
		if (!line) continue;
		yield JSON.parse(line);
		if (++n >= limit) break;
	}
}

// A pre-joined source of truth is the thing DATA-001 forbids: a product carrying its own
// variants, or a variant carrying its product, removes a read the specification requires.
for await (const product of rows('product', 200)) {
	if ('variants' in product || 'inventory' in product) {
		failures.push('DATA-001: product rows embed variants or inventory — the fan-out has been pre-joined away');
		break;
	}
}
for await (const variant of rows('variant', 200)) {
	if ('product' in variant || 'inventory' in variant) {
		failures.push('DATA-001: variant rows embed their product or inventory');
		break;
	}
}

// --- DATA-002: money is integer minor units at rest --------------------------------------
const MONEY = { variant: ['basePrice', 'weight'], customer: ['loyaltyBalance'], promotion: ['amountMinor', 'thresholdMinor'], rate: ['amountMinor', 'basisPoints'] };
for (const [table, fields] of Object.entries(MONEY)) {
	for await (const row of rows(table, 5000)) {
		for (const field of fields) {
			if (row[field] !== undefined && !Number.isInteger(row[field])) {
				failures.push(`DATA-002: ${table}.${field} is not an integer (${row[field]})`);
			}
		}
	}
}

// --- DATA-003: every file matches the manifest -------------------------------------------
for (const [table, meta] of Object.entries(manifest.files)) {
	const gz = manifest.compressed;
	const hash = createHash('sha256');
	let lines = 0;
	const input = gz
		? createReadStream(join(dir, `${table}.ndjson.gz`)).pipe(createGunzip())
		: createReadStream(join(dir, `${table}.ndjson`));
	for await (const chunk of input) {
		hash.update(chunk);
		for (const byte of chunk) if (byte === 10) lines++;
	}
	const actual = hash.digest('hex');
	if (actual !== meta.sha256) failures.push(`DATA-003: ${table} checksum ${actual.slice(0, 12)} != manifest ${meta.sha256.slice(0, 12)}`);
	if (lines !== meta.rows) failures.push(`DATA-003: ${table} has ${lines} rows, manifest says ${meta.rows}`);
}

// --- DATA-005: deterministic and version controlled --------------------------------------
if (!manifest.seed) failures.push('DATA-005: the manifest names no seed, so the dataset cannot be regenerated');
if (!manifest.generatorVersion) failures.push('DATA-005: the manifest names no generator version');
if (!manifest.distributions || Object.keys(manifest.distributions).length === 0) {
	failures.push('DATA-005: the manifest declares no distributions, so what it contains is undocumented');
}
try {
	await stat(join(import.meta.dirname, '..', 'packages', 'seed', 'src', 'cli.ts'));
} catch {
	failures.push('DATA-005: the generator is not committed — a dataset nobody can regenerate is a magic file');
}

console.log(`dataset ${scale}: seed ${manifest.seed}, generator ${manifest.generatorVersion}`);
console.log('  checksums verified over uncompressed bytes');

if (failures.length) {
	console.error(`\nFAIL — ${failures.length} dataset requirement(s) not met:`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log('\nOK — dataset requirements met.');
