/**
 * Assert that the indexed promotion probe returns a SUPERSET of the eligible set.
 *
 * The lookup in resources/quote.js narrows 5,000 promotions to a candidate set with two
 * indexed `in` probes. If that narrowing can ever EXCLUDE an eligible promotion, quotes are
 * silently cheaper and silently wrong — which is exactly what happened the first time this
 * was indexed, when a promotion unrestricted on both tier and category became unreachable.
 *
 * Runs offline against the committed dataset: it is a property of the data and the
 * predicate, so it needs no server and can run in CI.
 *
 *   node scripts/verify-promotion-index.mjs [--scale dev]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { isEligible } from '../resources/lib/pricing.js';
import { UNRESTRICTED } from '@ecommerce-store/spec';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const scale = argOf('scale', 'dev');
const dir = resolve(argOf('dataset', scale === 'dev'
	? join(import.meta.dirname, '..', 'dataset', 'dev')
	: join(import.meta.dirname, '..', '.work', 'dataset', scale)));

const promotions = [];
for await (const line of createInterface({ input: createReadStream(join(dir, 'promotion.ndjson')), crlfDelay: Infinity })) {
	if (line) promotions.push(JSON.parse(line));
}

/** The same narrowing the indexed probe performs: tierKeys IN (...) AND categoryKeys IN (...). */
const probe = (tier, categoryIds) => {
	const tierWanted = new Set([tier, UNRESTRICTED]);
	const catWanted = new Set([...categoryIds, UNRESTRICTED]);
	return promotions.filter(
		(p) => p.tierKeys.some((k) => tierWanted.has(k)) && p.categoryKeys.some((k) => catWanted.has(k))
	);
};

const TIERS = ['standard', 'silver', 'gold', 'platinum'];
const CATEGORIES = [...new Set(promotions.flatMap((p) => p.categoryIds))].filter(Boolean);

let checks = 0;
let missed = 0;
let candidateTotal = 0;
const examples = [];

// Every tier against every plausible cart category set: singletons, pairs, and the whole set.
const categorySets = [
	...CATEGORIES.map((c) => [c]),
	...CATEGORIES.slice(0, 8).flatMap((a, i) => CATEGORIES.slice(i + 1, i + 4).map((b) => [a, b])),
	CATEGORIES,
	[],
];

for (const tier of TIERS) {
	for (const categoryIds of categorySets) {
		checks++;
		const candidates = probe(tier, categoryIds);
		candidateTotal += candidates.length;
		const candidateIds = new Set(candidates.map((p) => p.id));
		// Anything the FULL set would consider eligible for some line in such a cart.
		for (const promotion of promotions) {
			const eligible = isEligible(promotion, { tier, sku: '__any__', categoryIds })
				// `skus` is not an index dimension; a SKU-restricted promotion is reachable
				// through its other two, so judge it on those.
				|| (promotion.skus?.length && isEligible({ ...promotion, skus: [] }, { tier, sku: '__any__', categoryIds }));
			if (eligible && !candidateIds.has(promotion.id)) {
				missed++;
				if (examples.length < 5) examples.push({ tier, categoryIds, promotion: promotion.id, tiers: promotion.tiers, categoryIds_: promotion.categoryIds });
			}
		}
	}
}

console.log(`scale ${scale}: ${promotions.length} promotions, ${checks} tier x category combinations checked`);
console.log(`mean candidates per probe: ${(candidateTotal / checks).toFixed(0)} of ${promotions.length} (${((candidateTotal / checks / promotions.length) * 100).toFixed(1)}%)`);

if (missed) {
	console.error(`\nFAIL — the index excluded ${missed} eligible promotion(s):`);
	for (const e of examples) console.error(`  ${JSON.stringify(e)}`);
	process.exit(1);
}
console.log('\nOK — the indexed probe is a superset of the eligible set in every combination.');
