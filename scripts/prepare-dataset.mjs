/**
 * Expand the committed benchmark dataset, and verify it.
 *
 * The `bench` dataset is committed gzipped because it is large enough that storing it raw is
 * hostile to anyone cloning the repo. Nothing reads the compressed form directly: a run
 * expands it first, here.
 *
 *   node scripts/prepare-dataset.mjs --scale bench --out .work/dataset
 *
 * Checksums in MANIFEST.json are over the UNCOMPRESSED bytes, so this verifies the thing the
 * contract is actually about (DATA-003) rather than the transport. `dev` is committed raw
 * and is verified in place without copying.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const scale = argOf('scale', 'bench');
const srcDir = resolve(argOf('src', join(import.meta.dirname, '..', 'dataset', scale)));
const outDir = resolve(argOf('out', join(import.meta.dirname, '..', '.work', 'dataset', scale)));

const manifest = JSON.parse(await readFile(join(srcDir, 'MANIFEST.json'), 'utf8'));
const tables = Object.keys(manifest.files);

console.log(`scale ${manifest.scale} · seed ${manifest.seed} · ${manifest.compressed ? 'gzipped' : 'raw'}`);

if (!manifest.compressed && srcDir === outDir) {
	console.log('raw dataset, already in place — verifying only');
} else {
	await mkdir(outDir, { recursive: true });
}

let total = 0;
for (const table of tables) {
	const target = join(outDir, `${table}.ndjson`);
	const hash = createHash('sha256');

	if (manifest.compressed) {
		await pipeline(createReadStream(join(srcDir, `${table}.ndjson.gz`)), createGunzip(), createWriteStream(target));
	} else if (srcDir !== outDir) {
		await copyFile(join(srcDir, `${table}.ndjson`), target);
	}

	const readFrom = manifest.compressed || srcDir !== outDir ? target : join(srcDir, `${table}.ndjson`);
	for await (const chunk of createReadStream(readFrom)) hash.update(chunk);
	const actual = hash.digest('hex');
	if (actual !== manifest.files[table].sha256) {
		throw new Error(`${table} checksum mismatch\n  manifest ${manifest.files[table].sha256}\n  actual   ${actual}`);
	}
	total += manifest.files[table].rows;
	console.log(`  ${table.padEnd(10)} ${String(manifest.files[table].rows).padStart(10)} rows  verified`);
}

if (manifest.compressed || srcDir !== outDir) await copyFile(join(srcDir, 'MANIFEST.json'), join(outDir, 'MANIFEST.json'));
console.log(`\n${total.toLocaleString()} rows ready at ${outDir}`);
