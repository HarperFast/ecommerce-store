/**
 * Every reference to a section of SPEC.md must resolve to a heading that exists.
 *
 * References are written as anchors: a bare `SPEC.md#heading-anchor` in code comments, and a
 * markdown link to the same in documents — rather than as section numbers or quoted heading
 * text. An anchor is checkable and prose is not, which is how a
 * reference to a `#foldings` section of docs/data-model.md survived in schemas/store.graphql
 * long after that discussion had moved into SPEC.md.
 *
 * Renaming a heading now fails here instead of silently orphaning every pointer at it.
 *
 *   node scripts/check-spec-anchors.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, dirname, resolve } from 'node:path';

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

// This file names anchors in its own documentation and error messages. It is the checker,
// not a reference, so it does not check itself.
const SELF = relative(ROOT, new URL(import.meta.url).pathname);

for (const path of files(ROOT)) {
	const rel = relative(ROOT, path);
	if (rel === SELF) continue;
	const source = readFileSync(path, 'utf8');
	const lines = source.split('\n');

	lines.forEach((line, i) => {
		// Cross-file references from anywhere, plus same-document links inside SPEC.md itself.
		const refs = [...line.matchAll(/SPEC\.md#([\w-]+)/g)].map((m) => m[1]);
		if (rel === SPEC) refs.push(...[...line.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]));

		for (const ref of refs) {
			if (!anchors.has(ref)) problems.push(`${rel}:${i + 1}  SPEC.md#${ref} — no such heading`);
		}

		// A markdown link also has to point at SPEC.md from where it is written. The anchor can be
		// perfect and the path still wrong, which is how every link in docs/ pointed at a sibling
		// SPEC.md that is actually one directory up.
		for (const [, target] of line.matchAll(/\]\((\.{0,2}[\w./-]*SPEC\.md)#[\w-]+\)/g)) {
			const resolved = resolve(dirname(path), target);
			if (resolved !== join(ROOT, SPEC)) {
				const correct = relative(dirname(path), join(ROOT, SPEC)) || SPEC;
				problems.push(`${rel}:${i + 1}  links to ${target} — from here that path is not ${SPEC}; use ${correct}`);
			}
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
