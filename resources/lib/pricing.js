/**
 * The pricing engine — SPEC.md §4.
 *
 * Pure: no I/O, no clock, no randomness. Everything it needs is passed in, which is what
 * makes QUOTE-008 (byte-identical quotes for the same cart and dataset state) testable
 * without a running server, and what makes it the ground-truth correctness guard the
 * measurement rules require.
 *
 * All money is integer minor units. No float ever enters a total.
 */

/** Tier multipliers in basis points. Fixed, not drawn — must match packages/seed. */
const TIER_BASIS_POINTS = { standard: 10000, silver: 9500, gold: 9000, platinum: 8500 };

/** Round half-up to the minor unit. Applied per discount, not once at the end (SPEC.md §4). */
function applyBasisPoints(amount, basisPoints) {
	return Math.floor((amount * basisPoints + 5000) / 10000);
}

export function resolveUnitPrice(basePrice, tier) {
	const bp = TIER_BASIS_POINTS[tier] ?? TIER_BASIS_POINTS.standard;
	return applyBasisPoints(basePrice, bp);
}

/**
 * Is this promotion eligible for the given tier / sku / categories?
 * An empty array on a dimension means "no restriction on this dimension".
 */
export function isEligible(promotion, { tier, sku, categoryIds }) {
	if (promotion.tiers?.length && !promotion.tiers.includes(tier)) return false;
	if (promotion.skus?.length && !promotion.skus.includes(sku)) return false;
	if (promotion.categoryIds?.length && !promotion.categoryIds.some((c) => categoryIds.includes(c))) return false;
	return true;
}

function discountFor(promotion, amount) {
	if (promotion.amountBasisPoints) return applyBasisPoints(amount, promotion.amountBasisPoints);
	return Math.min(promotion.amountMinor ?? 0, amount);
}

/**
 * Evaluate promotions in the normative order — SPEC.md §4.
 *
 * The order is normative because stacking is order-dependent: without it two correct
 * implementations disagree on a total, which the measurement rules classify as
 * non-equivalent semantics (an invalid cell, not a close one).
 *
 *   1. exclusive — highest value wins; if one applies, nothing else does
 *   2. threshold — against the PRE-discount subtotal
 *   3. bogo      — the lowest-priced qualifying unit
 *   4. stackable — ascending promotion id
 *
 * Ties break on ascending promotion id at every step.
 */
export function evaluatePromotions({ lines, candidates, subtotal }) {
	const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const perLine = new Map(lines.map((l) => [l.sku, []]));
	let discountTotal = 0;

	const of = (kind) => candidates.filter((c) => c.promotion.kind === kind).sort((a, b) => byId(a.promotion, b.promotion));

	// 1. Exclusive. Evaluated against the whole cart; the highest-value one wins outright.
	const exclusives = of('exclusive');
	if (exclusives.length) {
		let best = null;
		let bestValue = -1;
		for (const candidate of exclusives) {
			const value = discountFor(candidate.promotion, subtotal);
			if (value > bestValue) {
				bestValue = value;
				best = candidate;
			}
		}
		if (best && bestValue > 0) {
			perLine.get(best.sku)?.push(best.promotion.id);
			return { discountTotal: Math.min(bestValue, subtotal), perLine };
		}
	}

	// 2. Threshold, against the pre-discount subtotal.
	for (const candidate of of('threshold')) {
		if (subtotal < (candidate.promotion.thresholdMinor ?? 0)) continue;
		const value = discountFor(candidate.promotion, subtotal);
		if (value <= 0) continue;
		discountTotal += value;
		perLine.get(candidate.sku)?.push(candidate.promotion.id);
	}

	// 3. BOGO, on the lowest-priced qualifying unit of the line.
	for (const candidate of of('bogo')) {
		const line = lines.find((l) => l.sku === candidate.sku);
		if (!line || line.quantity < 2) continue;
		discountTotal += line.unitPrice;
		perLine.get(candidate.sku)?.push(candidate.promotion.id);
	}

	// 4. Remaining stackables, ascending id.
	for (const candidate of of('stackable')) {
		const line = lines.find((l) => l.sku === candidate.sku);
		if (!line) continue;
		const value = discountFor(candidate.promotion, line.unitPrice * line.quantity);
		if (value <= 0) continue;
		discountTotal += value;
		perLine.get(candidate.sku)?.push(candidate.promotion.id);
	}

	return { discountTotal: Math.min(discountTotal, subtotal), perLine };
}

/** Shipping: the band whose weight range contains the cart's total weight, for the region. */
export function resolveShipping(rates, region, totalWeight) {
	for (const rate of rates) {
		if (rate.kind !== 'shipping' || rate.region !== region) continue;
		if (totalWeight >= rate.weightMin && totalWeight <= rate.weightMax) return rate.amountMinor;
	}
	return 0;
}

/** Tax: basis points for the jurisdiction, applied to the POST-discount subtotal (QUOTE-007). */
export function resolveTax(rates, jurisdiction, taxableAmount) {
	for (const rate of rates) {
		if (rate.kind !== 'tax' || rate.jurisdiction !== jurisdiction) continue;
		return applyBasisPoints(taxableAmount, rate.basisPoints);
	}
	return 0;
}
