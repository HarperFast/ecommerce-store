/**
 * The candidate set a quote reads — SPEC.md#promotions-are-read-per-quote.
 *
 * The workload defines which promotions a quote reads, so that every implementation's lookup
 * does the same work: the promotions open to every SKU that match the customer's tier and a
 * category in the cart, plus every promotion naming a SKU in the cart. It is a superset of the
 * eligible set; application code still decides each line on all three dimensions.
 *
 * A predicate, not a mechanism: how a datastore finds this set is the implementation's choice.
 */
import type { Promotion } from './model.ts';

export interface CandidateProbe {
	tier: string;
	/** The SKUs the cart's lines name. */
	skus: readonly string[];
	/** The categories the cart's products name. */
	categoryIds: readonly string[];
}

export function isCandidate(promotion: Pick<Promotion, 'tiers' | 'skus' | 'categoryIds'>, cart: CandidateProbe): boolean {
	if (promotion.skus?.length) return promotion.skus.some((sku) => cart.skus.includes(sku));
	if (promotion.tiers?.length && !promotion.tiers.includes(cart.tier)) return false;
	if (promotion.categoryIds?.length && !promotion.categoryIds.some((id) => cart.categoryIds.includes(id))) return false;
	return true;
}
