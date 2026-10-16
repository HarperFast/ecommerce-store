/**
 * Assert that the indexed promotion probe returns a SUPERSET of the eligible set.
 *
 * The lookup in resources/quote.js narrows 5,000 promotions to a candidate set by probing
 * `eligibilityKeys`, an index the schema computes. If that narrowing can ever EXCLUDE an
 * eligible promotion, quotes are silently cheaper and silently wrong — which is exactly what
 * happened the first time this was indexed, when a promotion unrestricted on both tier and
 * category became unreachable.
 *
 * The keys each row is indexed under come from the schema's own `@computed` expression, and
 * the keys a quote asks for from the quote's own builder, so the check also fails if the two
 * disagree. Rows with missing or empty keys must stay reachable too.
 *
 * Runs offline against the committed dataset: it is a property of the data and the
 * predicate, so it needs no server and can run in CI.
 *
 *   node scripts/verify-promotion-index.mjs [--scale dev]
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { isEligible } from '../resources/lib/pricing.js';
import { probeKeys } from '../resources/lib/promotion-index.js';

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

const schema = readFileSync(join(import.meta.dirname, '..', 'schemas', 'store.graphql'), 'utf8');
const promotionType = /^type Promotion\b[^{]*\{([^}]*)\}/m.exec(schema)?.[1] ?? '';
const expression = /^\s*eligibilityKeys:.*@computed\(from: "([^"]+)"\)/m.exec(promotionType)?.[1];
if (!expression) {
	console.error('FAIL — no @computed(from:) expression for Promotion.eligibilityKeys in schemas/store.graphql');
	process.exit(1);
}
// The scope Harper compiles it in (resources/graphql.ts): every declared attribute, undefined
// unless the record has it.
const declared = Object.fromEntries([...promotionType.matchAll(/^\s*(\w+):/gm)].map(([, name]) => [name, undefined]));
const indexedKeys = new Function('attributes', 'record', `with (attributes) { with (record) { return ${expression}; } }`);
const keysOf = (promotion) => new Set(indexedKeys(declared, promotion));
const keysByPromotion = new Map(promotions.map((p) => [p.id, keysOf(p)]));

const probe = (tier, categoryIds) => {
	const wanted = probeKeys(tier, categoryIds);
	return promotions.filter((p) => wanted.some((key) => keysByPromotion.get(p.id).has(key)));
};

// A row whose key arrays are missing or empty is unrestricted as far as the index can tell.
const keyless = [{}, { tierKeys: null, categoryKeys: null }, { tierKeys: [], categoryKeys: [] }, { tierKeys: ['gold'] }, { categoryKeys: ['apparel'] }];

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
		const wanted = probeKeys(tier, categoryIds);
		for (const row of keyless) {
			const keys = keysOf(row);
			const reachable = (row.tierKeys?.length && !row.tierKeys.includes(tier)) || (row.categoryKeys?.length && !row.categoryKeys.some((c) => categoryIds.includes(c)))
				|| wanted.some((key) => keys.has(key));
			if (!reachable) {
				missed++;
				if (examples.length < 5) examples.push({ tier, categoryIds, row });
			}
		}
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

console.log(`mean probe selectivity: ${((candidateTotal / checks / promotions.length) * 100).toFixed(1)}% of the corpus`);

if (missed) {
	console.error(`\nFAIL — the index excluded ${missed} eligible promotion(s):`);
	for (const e of examples) console.error(`  ${JSON.stringify(e)}`);
	process.exit(1);
}
console.log('\nOK — the indexed probe is a superset of the eligible set in every combination.');
