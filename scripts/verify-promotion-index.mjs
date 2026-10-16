/**
 * Assert that the quote's indexed candidate search returns exactly the specification's candidate
 * set (SPEC 0.3.0, "Promotions are read per quote"), and so a SUPERSET of the eligible set.
 *
 * If the search ever EXCLUDES an eligible promotion, quotes are silently cheaper and silently
 * wrong, which is what happened the first time this was indexed, when a promotion unrestricted
 * on both tier and category became unreachable. If it returns more than the candidate set, the
 * reference reads more than the specification asks every implementation to read.
 *
 * The keys each row is indexed under come from the schema's own `@computed` expression, and the
 * conditions come from the quote's own builder, attribute names included, so the check also
 * fails if the two disagree or a condition names an attribute the schema does not index.
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
import { candidateConditions } from '../resources/lib/promotion-index.js';

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
const indexed = new Set([...promotionType.matchAll(/^\s*(\w+):[^\n]*@indexed/gm)].map(([, name]) => name));
// The scope Harper compiles it in (resources/graphql.ts): every declared attribute, undefined
// unless the record has it.
const declared = Object.fromEntries([...promotionType.matchAll(/^\s*(\w+):/gm)].map(([, name]) => [name, undefined]));
const computedKeys = new Function('attributes', 'record', `with (attributes) { with (record) { return ${expression}; } }`);

/** The values a row is indexed under, per attribute, as Harper would index them. */
function indexedValues(promotion) {
	const values = { eligibilityKeys: new Set(computedKeys(declared, promotion)) };
	for (const name of indexed) if (!(name in values)) values[name] = new Set(promotion[name] ?? []);
	return values;
}

/** The search the quote sends, run against the rows as Harper would index them: a union of equality probes. */
function search(rows, cart) {
	const conditions = candidateConditions(cart.tier, cart.categoryIds, cart.skus);
	for (const { attribute } of conditions) {
		if (!indexed.has(attribute)) throw new Error(`a candidate condition names ${attribute}, which schemas/store.graphql does not index`);
	}
	return rows.filter((row) => conditions.some(({ attribute, value }) => row.values[attribute].has(value)));
}

/** The candidate set the specification defines. */
function isCandidate(promotion, cart) {
	if (promotion.skus?.length) return promotion.skus.some((sku) => cart.skus.includes(sku));
	if (promotion.tiers?.length && !promotion.tiers.includes(cart.tier)) return false;
	if (promotion.categoryIds?.length && !promotion.categoryIds.some((id) => cart.categoryIds.includes(id))) return false;
	return true;
}

const rows = promotions.map((promotion) => ({ promotion, values: indexedValues(promotion) }));

// Rows the dataset may not contain: keys missing or empty, and a SKU-scoped promotion whose
// tiers and categories alone would match, which must not be found through them.
const synthetic = [
	{}, { tierKeys: null, categoryKeys: null }, { tierKeys: [], categoryKeys: [] }, { tiers: ['gold'], tierKeys: ['gold'] }, { categoryIds: ['apparel'], categoryKeys: ['apparel'] },
	{ skus: ['sku-synthetic'], tiers: ['gold'], tierKeys: ['gold'], categoryIds: ['apparel'], categoryKeys: ['apparel'] },
	{ skus: ['sku-synthetic'], tierKeys: ['*'], categoryKeys: ['*'] },
].map((promotion, i) => ({ id: `synthetic-${i}`, ...promotion })).map((promotion) => ({ promotion, values: indexedValues(promotion) }));

const TIERS = ['standard', 'silver', 'gold', 'platinum'];
const CATEGORIES = [...new Set(promotions.flatMap((p) => p.categoryIds))].filter(Boolean);
const SKUS = [...new Set(promotions.flatMap((p) => p.skus ?? []))];

// Every tier against every plausible cart category set (singletons, pairs, all, none), each with
// no SKU in any promotion, one that is, two that are, and the synthetic row's.
const categorySets = [
	...CATEGORIES.map((c) => [c]),
	...CATEGORIES.slice(0, 8).flatMap((a, i) => CATEGORIES.slice(i + 1, i + 4).map((b) => [a, b])),
	CATEGORIES,
	[],
];
const skuSets = [['sku-in-no-promotion'], SKUS.slice(0, 1), SKUS.slice(1, 3), ['sku-synthetic', 'sku-in-no-promotion']].filter((set) => set.length);

let checks = 0;
let failures = 0;
let candidateTotal = 0;
const examples = [];
const fail = (example) => {
	failures++;
	if (examples.length < 5) examples.push(example);
};

for (const tier of TIERS) {
	for (const categoryIds of categorySets) {
		for (const skus of skuSets) {
			checks++;
			const cart = { tier, categoryIds, skus };
			for (const row of synthetic) {
				if (search([row], cart).length !== (isCandidate(row.promotion, cart) ? 1 : 0)) fail({ cart, row: row.promotion });
			}
			const found = new Set(search(rows, cart).map((row) => row.promotion.id));
			candidateTotal += found.size;
			for (const { promotion } of rows) {
				if (found.has(promotion.id) !== isCandidate(promotion, cart)) fail({ cart, promotion: promotion.id, found: found.has(promotion.id) });
				// Anything eligible for some line of such a cart: one per SKU, and one whose SKU no promotion names.
				const eligible = [...skus, 'sku-unnamed'].some((sku) => isEligible(promotion, { tier, sku, categoryIds }));
				if (eligible && !found.has(promotion.id)) fail({ cart, promotion: promotion.id, eligible: true });
			}
		}
	}
}

console.log(`mean candidate set: ${(candidateTotal / checks).toFixed(1)} of ${promotions.length} promotions`);

if (failures) {
	console.error(`\nFAIL — the search differs from the candidate set, or misses an eligible promotion, ${failures} time(s):`);
	for (const e of examples) console.error(`  ${JSON.stringify(e)}`);
	process.exit(1);
}
console.log('\nOK — the indexed search returns exactly the candidate set, a superset of the eligible set, in every combination.');
