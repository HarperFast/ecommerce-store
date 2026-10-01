/**
 * The pricing engine — SPEC.md §4.
 *
 * Pure: no I/O, no clock, no randomness. Everything it needs is passed in, which is what
 * makes QUOTE-008 (byte-identical quotes for the same cart and dataset state) testable
 * without a running server, and what makes it the ground-truth correctness guard the
 * measurement rules require.
 *
 * All money is integer minor units. No float ever enters a total.
 *
 * The central rule, learned the hard way: **each PROMOTION applies at most once.** The
 * caller builds candidates as a lines x promotions cross product, so one cart-wide promotion
 * eligible for three lines arrives as three candidates. Treating those as three applications
 * made a 34%-off threshold promotion zero out a cart — a well-formed, deterministic, 200 OK
 * response that passed every conformance assertion.
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
 * A promotion with a `thresholdMinor` requires that minimum spend, whatever its kind. Fixed
 * amounts carry one so a flat discount cannot exceed the cart it lands on.
 */
function meetsThreshold(promotion, subtotal) {
	return subtotal >= (promotion.thresholdMinor ?? 0);
}

const byPromotionId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Stacking limits — SPEC.md §4.
 *
 * Real stores bound stacking; without a bound, a corpus with enough unrestricted stackables
 * compounds a cart toward zero and the benchmark prices free carts. These are normative so
 * every implementation produces the same total, not tuning knobs.
 */
const MAX_STACKABLE_PER_LINE = 3;
const MAX_DISCOUNT_BASIS_POINTS = 6000;

/**
 * Collapse the candidate cross product into one entry per promotion, carrying the set of
 * lines it is eligible for. Sorted by promotion id so evaluation order never depends on the
 * order candidates happened to be built in — QUOTE-008.
 */
function groupByPromotion(candidates) {
	const grouped = new Map();
	for (const { sku, promotion } of candidates) {
		let entry = grouped.get(promotion.id);
		if (!entry) {
			entry = { promotion, skus: [] };
			grouped.set(promotion.id, entry);
		}
		if (!entry.skus.includes(sku)) entry.skus.push(sku);
	}
	for (const entry of grouped.values()) entry.skus.sort();
	return [...grouped.values()].sort((a, b) => byPromotionId(a.promotion, b.promotion));
}

/**
 * Evaluate promotions in the normative order — SPEC.md §4.
 *
 * The order is normative because stacking is order-dependent: without it two correct
 * implementations disagree on a total, which the measurement rules classify as
 * non-equivalent semantics (an invalid cell, not a close one).
 *
 *   1. exclusive — cart-wide, highest value wins; if one applies, nothing else does
 *   2. threshold — cart-wide, against the PRE-discount subtotal, each promotion once
 *   3. bogo      — the single lowest-priced qualifying unit, each promotion once
 *   4. stackable — against the line's REMAINING amount, so discounts compound
 *
 * Ties break on ascending promotion id at every step.
 *
 * Two accumulators, because cart-wide and per-line discounts cannot share one budget without
 * one silently eating the other's headroom:
 *   - `cartDiscount` for exclusive/threshold, capped at the subtotal
 *   - per-line `remaining`, which bogo/stackable draw down, so a line can never be discounted
 *     below zero and a percentage promotion compounds against what is actually left
 */
export function evaluatePromotions({ lines, candidates, subtotal }) {
	const perLine = new Map(lines.map((l) => [l.sku, []]));
	const lineFor = new Map(lines.map((l) => [l.sku, l]));
	const remaining = new Map(lines.map((l) => [l.sku, l.unitPrice * l.quantity]));

	const grouped = groupByPromotion(candidates);
	const of = (kind) => grouped.filter((entry) => entry.promotion.kind === kind);

	/** A cart-wide promotion is attributed to every line it was eligible for. */
	const attribute = (entry) => {
		for (const sku of entry.skus) perLine.get(sku)?.push(entry.promotion.id);
	};

	// 1. Exclusive — cart-wide. The highest-value one wins outright; nothing else applies.
	const exclusives = of('exclusive');
	if (exclusives.length) {
		let best = null;
		let bestValue = -1;
		for (const entry of exclusives) {
			if (!meetsThreshold(entry.promotion, subtotal)) continue;
			const value = discountFor(entry.promotion, subtotal);
			// Strict >: ties keep the lower id, since `grouped` is already id-sorted.
			if (value > bestValue) {
				bestValue = value;
				best = entry;
			}
		}
		if (best && bestValue > 0) {
			attribute(best);
			return {
				discountTotal: Math.min(bestValue, applyBasisPoints(subtotal, MAX_DISCOUNT_BASIS_POINTS), subtotal),
				perLine,
			};
		}
	}

	let cartDiscount = 0;

	// 2. Threshold — cart-wide, against the pre-discount subtotal. Once per promotion.
	for (const entry of of('threshold')) {
		if (!meetsThreshold(entry.promotion, subtotal)) continue;
		const value = Math.min(discountFor(entry.promotion, subtotal), subtotal - cartDiscount);
		if (value <= 0) continue;
		cartDiscount += value;
		attribute(entry);
	}

	// 3. BOGO — the single lowest-priced qualifying unit, once per promotion. Ties on the
	//    lower sku, so the choice does not depend on cart line order.
	for (const entry of of('bogo')) {
		const qualifying = entry.skus
			.map((sku) => lineFor.get(sku))
			.filter((line) => line && line.quantity >= 2 && (remaining.get(line.sku) ?? 0) > 0)
			.sort((a, b) => a.unitPrice - b.unitPrice || (a.sku < b.sku ? -1 : 1));
		const line = qualifying[0];
		if (!line) continue;
		const value = Math.min(line.unitPrice, remaining.get(line.sku));
		if (value <= 0) continue;
		remaining.set(line.sku, remaining.get(line.sku) - value);
		perLine.get(line.sku)?.push(entry.promotion.id);
	}

	// 4. Stackable — against each eligible line's REMAINING amount, so successive percentage
	//    discounts compound instead of all computing against the gross line total. At most
	//    MAX_STACKABLE_PER_LINE apply to any line, in ascending promotion id.
	const stackedOnLine = new Map(lines.map((l) => [l.sku, 0]));
	for (const entry of of('stackable')) {
		if (!meetsThreshold(entry.promotion, subtotal)) continue;
		let applied = false;
		for (const sku of entry.skus) {
			if ((stackedOnLine.get(sku) ?? 0) >= MAX_STACKABLE_PER_LINE) continue;
			const left = remaining.get(sku) ?? 0;
			if (left <= 0) continue;
			const value = Math.min(discountFor(entry.promotion, left), left);
			if (value <= 0) continue;
			remaining.set(sku, left - value);
			stackedOnLine.set(sku, (stackedOnLine.get(sku) ?? 0) + 1);
			applied = true;
		}
		if (applied) attribute(entry);
	}

	const lineDiscount = lines.reduce((sum, l) => sum + (l.unitPrice * l.quantity - remaining.get(l.sku)), 0);
	// The cap is the LAST thing applied, so it bounds every path including a single
	// large exclusive. Stated in basis points to stay in integer minor units.
	const cap = applyBasisPoints(subtotal, MAX_DISCOUNT_BASIS_POINTS);
	return { discountTotal: Math.min(cartDiscount + lineDiscount, cap, subtotal), perLine };
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
