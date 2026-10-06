/**
 * Assert that every MUST in SPEC.md is covered by at least one test — SPEC.md, "Conformance".
 *
 * Static: scans test titles for the `[REQ-ID ...]` prefix that `covers()` emits, so it runs
 * without a live implementation. Exits non-zero on a gap.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageGaps, activeRequirements, requirement } from '@ecommerce-store/spec';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS = join(HERE, '..', 'tests');
/**
 * Some requirements are not properties of a request.
 *
 * DATA-004 and the WRITE-* family are about what the harness offered and what the dataset
 * was; DATA-001/003/005 are about the committed artifact. A Playwright test for any of them
 * would assert nothing, so they are covered by checker scripts that declare what they cover
 * with a `COVERS:` line. Coverage means "something actually verifies this", not "a test file
 * mentions it".
 */
const SCRIPTS = join(HERE, '..', '..', 'scripts');

const covered = new Set();
const sources = [];
for (const file of await readdir(TESTS)) {
	if (file.endsWith('.spec.ts')) sources.push(['test', join(TESTS, file)]);
}
for (const file of await readdir(SCRIPTS)) {
	if (file.endsWith('.mjs')) sources.push(['script', join(SCRIPTS, file)]);
}

for (const [kind, path] of sources) {
	const source = await readFile(path, 'utf8');
	if (kind === 'test') {
		for (const [, args] of source.matchAll(/covers\(([^)]*)\)/g)) {
			for (const [, id] of args.matchAll(/['"]([A-Z]+-\d+)['"]/g)) covered.add(id);
		}
	} else {
		const declared = source.match(/^\s*\*\s*COVERS:(.*)$/m);
		if (declared) for (const [id] of declared[1].matchAll(/[A-Z]+-\d+/g)) covered.add(id);
	}
}

const active = activeRequirements();
const musts = active.filter((r) => r.level === 'MUST');
const gaps = coverageGaps(covered);

console.log(`${active.length} active requirements, ${musts.length} MUST`);
console.log(`covered by tests: ${covered.size}`);

if (gaps.length) {
	console.error(`\nFAIL — ${gaps.length} MUST requirement(s) have no test:`);
	for (const id of gaps) console.error(`  ${id}  ${requirement(id).summary}`);
	process.exit(1);
}
console.log('\nOK — every MUST is covered.');
