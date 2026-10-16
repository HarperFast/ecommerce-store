/** The conditions of a quote's candidate search; `Promotion.eligibilityKeys` is computed in schemas/store.graphql. */
import { UNRESTRICTED } from '@ecommerce-store/spec';

function eligibilityKey(tierKey, categoryKey) {
	return `${tierKey}|${categoryKey}`;
}

function probeKeys(tier, categoryIds) {
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
