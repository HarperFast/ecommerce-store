/**
 * Assert that every MUST in SPEC.md is covered by at least one test — SPEC.md §8.
 *
 * Static: scans test titles for the `[REQ-ID ...]` prefix that `covers()` emits, so it runs
 * without a live implementation. Exits non-zero on a gap.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageGaps, activeRequirements, requirement } from '@ecommerce-store/spec';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests');

const covered = new Set();
for (const file of await readdir(TESTS)) {
	if (!file.endsWith('.spec.ts')) continue;
	const source = await readFile(join(TESTS, file), 'utf8');
	for (const [, args] of source.matchAll(/covers\(([^)]*)\)/g)) {
		for (const [, id] of args.matchAll(/['"]([A-Z]+-\d+)['"]/g)) covered.add(id);
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
