/**
 * The conditions a quote's candidate search sends: the campaign pairs its tier and categories
 * can match on `Promotion.eligibilityKeys`, whose `@computed` expression is in
 * schemas/store.graphql, and each of its SKUs on `Promotion.skus`.
 */
import { UNRESTRICTED } from '@ecommerce-store/spec';

function eligibilityKey(tierKey, categoryKey) {
	return `${tierKey}|${categoryKey}`;
}

export function probeKeys(tier, categoryIds) {
	const categoryKeys = [...categoryIds, UNRESTRICTED];
	const keys = [];
	for (const tierKey of [tier, UNRESTRICTED]) {
		for (const categoryKey of categoryKeys) keys.push(eligibilityKey(tierKey, categoryKey));
	}
	return keys;
}

export function candidateConditions(tier, categoryIds, skus) {
	const conditions = probeKeys(tier, categoryIds).map((value) => ({ attribute: 'eligibilityKeys', value }));
	for (const sku of skus) conditions.push({ attribute: 'skus', value: sku });
	return conditions;
}
