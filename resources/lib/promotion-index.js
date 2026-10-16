/**
 * The keys a cart probes `Promotion.eligibilityKeys` with. The schema's `@computed` expression
 * builds the keys each promotion is indexed under; scripts/verify-promotion-index.mjs fails if
 * the two formats disagree.
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
