/** The keys a cart probes `Promotion.eligibilityKeys` with; see its `@computed` expression in schemas/store.graphql. */
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
