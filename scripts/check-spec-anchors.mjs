/**
 * Every reference to a section of SPEC.md must resolve to a heading that exists.
 *
 * References are written as anchors — `SPEC.md#background-writes` in code comments,
 * `[Background writes](SPEC.md#background-writes)` in documents — rather than as section
 * numbers or quoted heading text. An anchor is checkable; prose is not, which is how a
 * reference to a `#foldings` section of docs/data-model.md survived in schemas/store.graphql
 * long after that discussion had moved into SPEC.md.
 *
 * Renaming a heading now fails here instead of silently orphaning every pointer at it.
 *
 *   node scripts/check-spec-anchors.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SPEC = 'SPEC.md';

/** GitHub's heading-anchor algorithm: lowercase, drop punctuation, spaces to hyphens. */
function anchorOf(heading) {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/^-+|-+$/g, '');
}

const spec = readFileSync(join(ROOT, SPEC), 'utf8');
const headings = [...spec.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map((m) => m[1]);
const anchors = new Set(headings.map(anchorOf));

const SKIP = new Set(['node_modules', '.git', '.work', 'dataset', 'test-results', 'playwright-report']);
const EXT = new Set(['.md', '.js', '.mjs', '.ts', '.tsx', '.graphql', '.yaml', '.yml', '.sh']);

function* files(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (EXT.has(extname(name))) yield path;
	}
}

const problems = [];

for (const path of files(ROOT)) {
	const rel = relative(ROOT, path);
	const source = readFileSync(path, 'utf8');
	const lines = source.split('\n');

	lines.forEach((line, i) => {
		// Cross-file references from anywhere, plus same-document links inside SPEC.md itself.
		const refs = [...line.matchAll(/SPEC\.md#([\w-]+)/g)].map((m) => m[1]);
		if (rel === SPEC) refs.push(...[...line.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]));

		for (const ref of refs) {
			if (!anchors.has(ref)) problems.push(`${rel}:${i + 1}  SPEC.md#${ref} — no such heading`);
		}
	});
}

if (problems.length) {
	console.error('FAIL — SPEC.md section references that resolve to nothing:');
	for (const p of problems) console.error(`  ${p}`);
	console.error('\nValid anchors:');
	for (const a of [...anchors].sort()) console.error(`  #${a}`);
	process.exit(1);
}

console.log('OK — every SPEC.md section reference resolves.');
