/**
 * Assert that every MUST in SPEC.md is covered by at least one test — SPEC.md §11.
 *
 * Static: scans test titles for the `[REQ-ID ...]` prefix that `covers()` emits, so it runs
 * without a live implementation. Exits non-zero on a gap.
 *
 *   PROFILE=DATA node scripts/coverage.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageGaps, requirementsFor, REQUIREMENTS } from '@ecommerce-store/spec';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests');
const profile = process.env.PROFILE ?? 'APP';

const covered = new Set();
for (const file of await readdir(TESTS)) {
	if (!file.endsWith('.spec.ts')) continue;
	const source = await readFile(join(TESTS, file), 'utf8');
	// The ids as they reach a test title: covers('PLP-001', 'PLP-005')
	for (const [, args] of source.matchAll(/covers\(([^)]*)\)/g)) {
		for (const [, id] of args.matchAll(/['"]([A-Z]+-\d+)['"]/g)) covered.add(id);
	}
}

const applicable = requirementsFor(profile);
const musts = applicable.filter((r) => r.level === 'MUST');
const gaps = coverageGaps(covered, profile);

console.log(`profile ${profile}: ${applicable.length} applicable requirements, ${musts.length} MUST`);
console.log(`covered by tests: ${covered.size} of ${REQUIREMENTS.length} total requirement ids`);

if (gaps.length) {
	console.error(`\nFAIL — ${gaps.length} MUST requirement(s) have no test:`);
	for (const id of gaps) {
		console.error(`  ${id}  ${REQUIREMENTS.find((r) => r.id === id)?.summary}`);
	}
	process.exit(1);
}
console.log('\nOK — every applicable MUST is covered.');
