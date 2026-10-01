/**
 * Load the committed dataset into a running Harper instance.
 *
 * Seeding is explicitly NOT measured (benchmarks README, run lifecycle): bulk loading
 * millions of records is a one-off operation, not application behaviour a customer
 * experiences. This exists to be correct and restartable, not fast.
 *
 *   node scripts/load-dataset.mjs [--url http://localhost:9925] [--batch 5000]
 *
 * Verifies MANIFEST.json checksums before loading — DATA-003. A dataset that does not match
 * its manifest is not the dataset the comparison claims to have run against.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const OPS_URL = argOf('url', 'http://localhost:9925');
const BATCH = Number(argOf('batch', '5000'));
const DIR = resolve(argOf('dataset', join(import.meta.dirname, '..', 'dataset')));
const DATABASE = argOf('database', 'data');
const VERIFY = !args.includes('--skip-verify');

// Load order matters only for readability; there are no foreign keys to satisfy.
const TABLES = ['location', 'rate', 'promotion', 'customer', 'product', 'variant', 'inventory', 'cart'];
const TABLE_NAME = {
	location: 'Location', rate: 'Rate', promotion: 'Promotion', customer: 'Customer',
	product: 'Product', variant: 'Variant', inventory: 'Inventory', cart: 'Cart',
};

const manifest = JSON.parse(await readFile(join(DIR, 'MANIFEST.json'), 'utf8'));
console.log(`dataset: scale ${manifest.scale}, seed ${manifest.seed}, generator ${manifest.generatorVersion}`);

async function operation(body) {
	const response = await fetch(OPS_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${body.operation} failed: ${response.status} ${await response.text()}`);
	return response.json();
}

if (VERIFY) {
	process.stdout.write('verifying checksums ');
	for (const table of TABLES) {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(join(DIR, `${table}.ndjson`))) hash.update(chunk);
		const actual = hash.digest('hex');
		if (actual !== manifest.files[table].sha256) {
			throw new Error(`\n${table}.ndjson checksum mismatch\n  manifest ${manifest.files[table].sha256}\n  actual   ${actual}`);
		}
		process.stdout.write('.');
	}
	console.log(' ok');
}

const started = Date.now();
let grandTotal = 0;

for (const table of TABLES) {
	const stream = createInterface({ input: createReadStream(join(DIR, `${table}.ndjson`)), crlfDelay: Infinity });
	let batch = [];
	let loaded = 0;

	const flush = async () => {
		if (!batch.length) return;
		await operation({ operation: 'insert', database: DATABASE, table: TABLE_NAME[table], records: batch });
		loaded += batch.length;
		batch = [];
		process.stdout.write(`\r  ${table.padEnd(10)} ${String(loaded).padStart(9)} / ${manifest.files[table].rows}`);
	};

	for await (const line of stream) {
		if (!line) continue;
		batch.push(JSON.parse(line));
		if (batch.length >= BATCH) await flush();
	}
	await flush();
	grandTotal += loaded;
	console.log(`\r  ${table.padEnd(10)} ${String(loaded).padStart(9)} rows`);
}

console.log(`\n${grandTotal.toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
