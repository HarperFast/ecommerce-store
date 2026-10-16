/**
 * The tier multipliers live in three places; this asserts they agree.
 *
 * SPEC.md#resolved-unit-price is normative. The reference's pricing engine applies its own copy,
 * and the seed vocabulary names the tiers customers are drawn from. Moving the multipliers into
 * `rate` rows would have left one copy, at the cost of changing both implementations' pricing;
 * keeping them in SPEC.md was decided on 2026-10-16, with this check against drift.
 *
 *   node scripts/check-tier-multipliers.mjs
 */
import { readFileSync } from 'node:fs';
import { resolveUnitPrice } from '../resources/lib/pricing.js';
import { TIERS, TIER_BASIS_POINTS } from '../packages/seed/src/vocabulary.ts';

const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
const section = spec.slice(spec.indexOf('### Resolved unit price'), spec.indexOf('### Promotion evaluation order'));
const normative = Object.fromEntries([...section.matchAll(/^\| `(\w+)` \| (\d+) \|/gm)].map(([, tier, bp]) => [tier, Number(bp)]));

const problems = [];
if (!Object.keys(normative).length) problems.push('no tier table found under SPEC.md "Resolved unit price"');
const same = (a, b) => [...a].sort().join() === [...b].sort().join();
if (!same(Object.keys(normative), TIERS)) problems.push(`SPEC.md tiers [${Object.keys(normative)}] differ from the seed's [${TIERS}]`);
for (const [tier, bp] of Object.entries(normative)) {
	if (TIER_BASIS_POINTS[tier] !== bp) problems.push(`${tier}: SPEC.md ${bp}, seed vocabulary ${TIER_BASIS_POINTS[tier]}`);
	// At a base price of 10000 the resolved price IS the multiplier, with no rounding to hide a difference.
	const applied = resolveUnitPrice(10000, tier);
	if (applied !== bp) problems.push(`${tier}: SPEC.md ${bp}, resources/lib/pricing.js applies ${applied}`);
}
const unknown = resolveUnitPrice(10000, 'no-such-tier');
if (unknown !== normative.standard) problems.push(`an unknown tier prices at ${unknown}; SPEC.md resolves it as standard (${normative.standard})`);

if (problems.length) {
	console.error('FAIL — the tier multipliers disagree:');
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log(`OK — SPEC.md, the pricing engine and the seed agree on ${Object.keys(normative).length} tier multipliers.`);
