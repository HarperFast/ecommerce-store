/**
 * SPEC.md and packages/spec are two halves of one document. This asserts they agree.
 *
 * Drift between them is silent and expensive: a requirement in the prose with no registry
 * entry is never covered by a test, and a registry entry with no prose has no normative
 * text behind it.
 *
 *   node scripts/check-spec-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { REQUIREMENTS } from '../packages/spec/src/index.ts';

const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');

// Area prefixes are 2-4 letters (RT, CAT, SRCH), then a three-digit number.
const ID = /\b([A-Z]{2,4}-\d{3})\b/g;

const inSpec = new Set([...spec.matchAll(ID)].map((m) => m[1]));
const inRegistry = new Map(REQUIREMENTS.map((r) => [r.id, r]));

const problems = [];

for (const id of [...inSpec].sort()) {
	if (!inRegistry.has(id)) problems.push(`${id}: in SPEC.md, missing from the registry`);
}
for (const id of [...inRegistry.keys()].sort()) {
	if (!inSpec.has(id)) problems.push(`${id}: in the registry, missing from SPEC.md`);
}

// Levels must match. SPEC.md states them as: `PLP-001` **MUST** — ...
for (const req of REQUIREMENTS) {
	const stated = spec.match(new RegExp('`' + req.id + '`\\s*\\*\\*(MUST|SHOULD|MAY)\\*\\*'));
	if (!stated) {
		problems.push(`${req.id}: no level stated in SPEC.md (expected \`${req.id}\` **${req.level}**)`);
	} else if (stated[1] !== req.level) {
		problems.push(`${req.id}: level is ${stated[1]} in SPEC.md but ${req.level} in the registry`);
	}
}

console.log(`SPEC.md: ${inSpec.size} ids · registry: ${inRegistry.size} ids`);
if (problems.length) {
	console.error(`\nFAIL — ${problems.length} inconsistency(ies):`);
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log('OK — SPEC.md and packages/spec agree on ids and levels.');
