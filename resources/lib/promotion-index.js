/**
 * The promotion eligibility index — docs/data-model.md#promotion-eligibility-index.
 *
 * A promotion carries one key per (tier key, category key) pair. `Promotion.eligibilityKeys`
 * in schemas/store.graphql derives the same keys with its own expression; the two must agree
 * or promotions become silently unreachable, and scripts/verify-promotion-index.mjs fails if
 * they do not.
 */
import { UNRESTRICTED } from '@ecommerce-store/spec';

export function eligibilityKey(tierKey, categoryKey) {
	return `${tierKey}|${categoryKey}`;
}

/** Every key a promotion that may apply to this cart can carry: its tier or any, crossed with each of its categories or any. */
export function probeKeys(tier, categoryIds) {
	const keys = [];
	for (const tierKey of [tier, UNRESTRICTED]) {
		for (const categoryKey of [...categoryIds, UNRESTRICTED]) keys.push(eligibilityKey(tierKey, categoryKey));
	}
	return keys;
}
