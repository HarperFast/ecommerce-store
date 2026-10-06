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

/**
 * The discount ceiling. Floors rather than rounding half-up: a cap that rounds UP can exceed
 * the bound it exists to enforce (at a subtotal of 1001, half-up yields 601, which is
 * 60.04%). A bound must never be exceeded by its own rounding.
 */
function discountCeiling(subtotal) {
	return Math.floor((subtotal * MAX_DISCOUNT_BASIS_POINTS) / 10000);
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
 * ONE budget: the per-line `remaining` map, which every phase draws down through `drawDown`.
 * Cart-wide discounts are allocated across the lines they are eligible for in proportion to
 * what each still has left. A separate cart-level accumulator alongside these lets both
 * discount the same money — the cap bounds the total either way, so the double-spend never
 * shows in `discountTotal`, only in per-line figures that stop summing to it.
 */
export function evaluatePromotions({ lines: inputLines, candidates, subtotal }) {
	/**
	 * Merge duplicate SKUs before evaluating.
	 *
	 * Every map in here is keyed by SKU, but neither SPEC.md nor the schema requires a cart's
	 * lines to be distinct — lines are an unrestricted embedded array. With a repeated SKU the
	 * maps held one entry while the total was summed once per line, producing a NEGATIVE
	 * discount (a quote charging above its own subtotal) for a cart with no promotions at all.
	 * Merging is the behaviour a shopper expects anyway: two entries of the same SKU are one
	 * line of a larger quantity.
	 */
	const merged = new Map();
	for (const line of inputLines) {
		const existing = merged.get(line.sku);
		if (existing) existing.quantity += line.quantity;
		else merged.set(line.sku, { ...line });
	}
	const lines = [...merged.values()];

	const perLine = new Map(lines.map((l) => [l.sku, []]));
	const lineFor = new Map(lines.map((l) => [l.sku, l]));
	/** The ONE budget. Every discount, cart-wide or per-line, draws this down. */
	const remaining = new Map(lines.map((l) => [l.sku, l.unitPrice * l.quantity]));

	const ceiling = discountCeiling(subtotal);
	const spent = () => lines.reduce((sum, l) => sum + (l.unitPrice * l.quantity - remaining.get(l.sku)), 0);
	const headroom = () => ceiling - spent();

	const grouped = groupByPromotion(candidates);
	const of = (kind) => grouped.filter((entry) => entry.promotion.kind === kind);

	/**
	 * Draw `amount` down across `skus` in proportion to what each still has left.
	 *
	 * Cart-wide promotions used to accumulate in their own counter while per-line promotions
	 * drew down `remaining`, so both discounted the SAME money and only the final clamp hid
	 * it — a 50% threshold plus a 50% stackable "discounted" 100% of a one-line cart. One
	 * budget makes that structurally impossible.
	 *
	 * Integer allocation by largest remainder, ties on ascending sku, so the split is exact
	 * and never depends on cart line order.
	 */
	const drawDown = (skus, amount) => {
		const eligible = skus.filter((sku) => (remaining.get(sku) ?? 0) > 0).sort();
		const pool = eligible.reduce((sum, sku) => sum + remaining.get(sku), 0);
		const budget = Math.min(amount, pool, headroom());
		if (budget <= 0) return [];
		const shares = eligible.map((sku) => {
			const exact = (remaining.get(sku) * budget) / pool;
			return { sku, whole: Math.floor(exact), frac: exact - Math.floor(exact) };
		});
		let allocated = shares.reduce((sum, s) => sum + s.whole, 0);
		for (const share of [...shares].sort((a, b) => b.frac - a.frac || (a.sku < b.sku ? -1 : 1))) {
			if (allocated >= budget) break;
			if (share.whole + 1 > remaining.get(share.sku)) continue;
			share.whole++;
			allocated++;
		}
		const touched = [];
		for (const share of shares) {
			if (share.whole <= 0) continue;
			remaining.set(share.sku, remaining.get(share.sku) - share.whole);
			touched.push(share.sku);
		}
		return touched;
	};

	/** Attribute a promotion to exactly the lines it actually discounted — QUOTE-012. */
	const attribute = (entry, skus) => {
		for (const sku of skus) perLine.get(sku)?.push(entry.promotion.id);
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
			const touched = drawDown(best.skus, bestValue);
			if (touched.length) {
				attribute(best, touched);
				return { discountTotal: spent(), perLine };
			}
		}
	}

	// 2. Threshold — cart-wide, against the pre-discount subtotal. Once per promotion.
	for (const entry of of('threshold')) {
		if (!meetsThreshold(entry.promotion, subtotal)) continue;
		const touched = drawDown(entry.skus, discountFor(entry.promotion, subtotal));
		if (touched.length) attribute(entry, touched);
	}

	// 3. BOGO — the single lowest-priced qualifying unit, once per promotion. Ties on the
	//    lower sku, so the choice does not depend on cart line order.
	for (const entry of of('bogo')) {
		const line = entry.skus
			.map((sku) => lineFor.get(sku))
			.filter((l) => l && l.quantity >= 2 && (remaining.get(l.sku) ?? 0) > 0)
			.sort((a, b) => a.unitPrice - b.unitPrice || (a.sku < b.sku ? -1 : 1))[0];
		if (!line) continue;
		// The promotion's own amount, against that ONE unit — not the line (SPEC.md §4 step 4).
		// The corpus carries 10000 basis points on every bogo row, which makes the unit free;
		// reading the magnitude rather than assuming it keeps a corpus that says otherwise correct.
		const touched = drawDown([line.sku], discountFor(entry.promotion, line.unitPrice));
		if (touched.length) attribute(entry, touched);
	}

	// 4. Stackable — against each eligible line's REMAINING amount, so successive percentage
	//    discounts compound. At most MAX_STACKABLE_PER_LINE apply to any one line.
	const stackedOnLine = new Map(lines.map((l) => [l.sku, 0]));
	for (const entry of of('stackable')) {
		if (!meetsThreshold(entry.promotion, subtotal)) continue;
		const touched = [];
		for (const sku of entry.skus) {
			if ((stackedOnLine.get(sku) ?? 0) >= MAX_STACKABLE_PER_LINE) continue;
			const left = remaining.get(sku) ?? 0;
			if (left <= 0) continue;
			const applied = drawDown([sku], discountFor(entry.promotion, left));
			if (!applied.length) continue;
			stackedOnLine.set(sku, (stackedOnLine.get(sku) ?? 0) + 1);
			touched.push(sku);
		}
		// Attributed to exactly the lines it discounted, never to every line it was eligible
		// for: a promotion cited on a line it did not reduce is a phantom id.
		if (touched.length) attribute(entry, touched);
	}

	return { discountTotal: spent(), perLine };
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
