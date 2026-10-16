/**
 * The dataset generator — SPEC.md#data-model, docs/seed-design.md.
 *
 * Yields rows table by table so the output streams: the benchmark dataset is deliberately
 * larger than memory, and holding it all before writing would force every implementation to
 * solve a problem the benchmark is not about.
 *
 * Determinism rules (docs/seed-design.md): one seeded PRNG consumed in a fixed order, ids
 * derived rather than drawn, no wall clock, integer minor units only.
 */
import { UNRESTRICTED, scramble } from '@ecommerce-store/spec';
import { Rng } from './prng.ts';
import {
	ADJECTIVES, BRANDS, CART_SIZE, CATEGORIES, JURISDICTIONS, LOCATIONS_PER_SKU,
	NOUNS, OPTION_AXES, REGIONS, TIERS, VARIANTS_PER_PRODUCT,
} from './vocabulary.ts';

export interface Scale {
	products: number;
	customers: number;
	carts: number;
	locationsPerRegion: number;
	promotions: number;
}

/**
 * `bench` is the only valid benchmark target — SPEC.md DATA-004 requires a working set that
 * does not fit in memory. `dev` exists for tests and iteration and must never appear in a
 * result (docs/seed-design.md).
 */
export const SCALES: Record<string, Scale> = {
	// Committed uncompressed and deliberately tiny: agents and humans need a catalog they can
	// load in seconds to work on the application. NEVER a benchmark target.
	dev: { products: 2_000, customers: 4_000, carts: 2_000, locationsPerRegion: 2, promotions: 160 },
	// Sized so the working set does NOT fit in memory on the benchmark container — DATA-004.
	// The container is pinned at 2 GiB (see containers/), and Harper's on-disk footprint with
	// indexes runs well above the raw NDJSON size, so ~3.2 GB raw clears 2 GiB with room to
	// spare. That Harper cannot hold the catalog in RAM is the requirement, not a side effect.
	// Committed GZIPPED; scripts/prepare-dataset.mjs expands it.
	bench: { products: 2_000_000, customers: 500_000, carts: 300_000, locationsPerRegion: 2, promotions: 5_000 },
};

const pad = (n: number, width = 6) => String(n).padStart(width, '0');

export const productId = (i: number) => `product-${pad(i)}`;
export const customerId = (i: number) => `customer-${pad(i)}`;
export const cartId = (i: number) => `cart-${pad(i)}`;
export const sku = (productIndex: number, variantIndex: number) => `sku-${pad(productIndex)}-${pad(variantIndex, 2)}`;

export function* locations(scale: Scale): Generator<Record<string, unknown>> {
	for (const region of REGIONS) {
		for (let i = 0; i < scale.locationsPerRegion; i++) {
			yield { id: `loc-${region}-${i}`, region, priority: i };
		}
	}
}

export function* customers(scale: Scale, rng: Rng): Generator<Record<string, unknown>> {
	for (let i = 0; i < scale.customers; i++) {
		yield {
			id: customerId(i),
			// Tiers are skewed: most shoppers are standard, few are platinum. A uniform split
			// would make tier-keyed cache entries evenly warm, which no real store sees.
			tier: rng.weighted([['standard', 60], ['silver', 25], ['gold', 12], ['platinum', 3]] as const),
			loyaltyBalance: rng.chance(0.4) ? rng.int(100, 50_000) : 0,
			region: rng.pick(REGIONS),
			taxJurisdiction: rng.pick(JURISDICTIONS),
		};
	}
}

/** Variant counts are needed by several tables, so the shape is derived once and reused. */
export function variantShape(scale: Scale, rng: Rng): number[] {
	const counts: number[] = [];
	for (let i = 0; i < scale.products; i++) counts.push(rng.weighted(VARIANTS_PER_PRODUCT));
	return counts;
}

/** `categoryOf`, when given, receives each product's category index: product promotions need it. */
export function* products(scale: Scale, counts: number[], rng: Rng, categoryOf?: Uint8Array): Generator<Record<string, unknown>> {
	for (let i = 0; i < scale.products; i++) {
		const categoryIndex = rng.int(0, CATEGORIES.length - 1);
		if (categoryOf) categoryOf[i] = categoryIndex;
		// Related items point at nearby ids, so the fan-out reads a clustered set rather than
		// a uniformly random one — which is what a real "related products" list looks like.
		const relatedCount = rng.int(2, 5);
		const related: string[] = [];
		for (let r = 0; r < relatedCount; r++) {
			const offset = rng.int(1, 40);
			const target = (i + offset) % scale.products;
			if (target !== i) related.push(productId(target));
		}
		const reviewCount = rng.chance(0.75) ? rng.int(1, 4_000) : 0;
		yield {
			id: productId(i),
			title: `${rng.pick(BRANDS)} ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}`,
			categoryIds: [CATEGORIES[categoryIndex]],
			weight: rng.int(80, 4_000),
			relatedProductIds: related,
			reviewRollup: {
				count: reviewCount,
				averageCentistars: reviewCount === 0 ? 0 : rng.int(250, 500),
			},
		};
	}
}

export function* variants(scale: Scale, counts: number[], rng: Rng): Generator<Record<string, unknown>> {
	const axisNames = Object.keys(OPTION_AXES) as (keyof typeof OPTION_AXES)[];
	for (let i = 0; i < scale.products; i++) {
		// Price is drawn per product so a product's variants cluster, then jittered per
		// variant. Drawing independently would erase the price structure a catalog has.
		const base = rng.int(500, 40_000);
		for (let v = 0; v < counts[i]; v++) {
			const options: Record<string, string> = {};
			for (const axis of axisNames) {
				if (axis === 'material' && !rng.chance(0.4)) continue;
				options[axis] = rng.pick(OPTION_AXES[axis]);
			}
			yield {
				sku: sku(i, v),
				productId: productId(i),
				options,
				basePrice: Math.max(100, base + rng.int(-800, 2_500)),
				weight: rng.int(80, 4_000),
			};
		}
	}
}

export function* inventory(scale: Scale, counts: number[], rng: Rng): Generator<Record<string, unknown>> {
	const all = [...locations(scale)].map((l) => l.id as string);
	for (let i = 0; i < scale.products; i++) {
		for (let v = 0; v < counts[i]; v++) {
			const stocked = rng.weighted(LOCATIONS_PER_SKU);
			// Walk from a rotating start so coverage is not biased toward the first location.
			const start = rng.int(0, all.length - 1);
			for (let k = 0; k < Math.min(stocked, all.length); k++) {
				const locationId = all[(start + k) % all.length];
				yield {
					id: `${sku(i, v)}:${locationId}`,
					sku: sku(i, v),
					locationId,
					// A meaningful fraction at zero, so availability resolution does real work
					// rather than always succeeding at the first location it tries.
					onHand: rng.chance(0.12) ? 0 : rng.int(1, 400),
				};
			}
		}
	}
}

/**
 * Campaign promotions: the store-wide, tier and category offers a merchandising team runs. A
 * fixed number at every scale, because the tiers and categories they target are a fixed
 * vocabulary; a bigger catalog adds product offers, not campaigns.
 */
export const CAMPAIGNS = 120;

/** Exclusives: at most one per category, in this many categories, each for one member tier. */
export const EXCLUSIVE_CATEGORIES = 4;
const EXCLUSIVE_TIERS = ['silver', 'gold'] as const;

/**
 * Promotions — QUOTE-005, SPEC.md#promotion-evaluation-order.
 *
 * The corpus has to reach every pricing phase at BOTH scales, and it failed that twice before:
 *
 * - Exclusives short-circuit everything. An early corpus gave every tier unrestricted
 *   exclusives, so no other phase ran. Generator 0.5.0 drew 3% of rows as exclusives, scoped by
 *   category only: `dev`'s 4 reached 67% of carts, and `bench`'s 168 covered every category with
 *   no threshold, so EVERY `bench` quote stopped at the exclusive step and threshold, BOGO,
 *   stackable and the cap applied in none.
 * - Density. `bench` had 31 times `dev`'s promotions in the same 52 tier x category cells, so
 *   about 630 were eligible for every `bench` cart. With exclusives bounded, thresholds alone
 *   hit the 60% cap on 86% of `bench` carts, leaving BOGO and stackable nothing to discount.
 *
 * So the corpus is two populations, interleaved by id:
 *
 * - `CAMPAIGNS` campaign promotions, the same structure at every scale. Exclusives are bounded:
 *   one each in `EXCLUSIVE_CATEGORIES` categories, each for one member tier, with a minimum
 *   spend. Cart-wide thresholds are scoped to one tier AND one category, so a cart meets one or
 *   two rather than enough to reach the cap on their own.
 * - Product promotions for the rest, which is where a large catalog's offers are. Each is
 *   restricted to one product's SKUs and that product's category, and most are open to every
 *   tier. Products are drawn from the access distribution, so promoted products are popular
 *   ones, as they are in a real store; no product is drawn twice. These are the only rows that
 *   exercise QUOTE-005's SKU dimension.
 *
 * Interleaved, because ties and the three-stackables-per-line limit go by ascending id: product
 * promotions numbered after every campaign would almost never get a line's stackable slots.
 * Campaigns, products and the interleaving each draw from their own stream, so the campaign
 * rows are identical at every scale.
 *
 * `scripts/verify-pricing-phases.mjs` fails `npm run check` if any phase leaves its band.
 */
export function* promotions(scale: Scale, counts: number[], categoryOf: Uint8Array, seed: string): Generator<Record<string, unknown>> {
	const order = new Rng(`${seed}:order`);
	const campaignRng = new Rng(`${seed}:campaign`);
	const productRng = new Rng(`${seed}:product`);
	const shuffled = [...CATEGORIES];
	for (let k = shuffled.length - 1; k > 0; k--) {
		const j = campaignRng.int(0, k);
		[shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
	}
	const exclusiveCategories = shuffled.slice(0, EXCLUSIVE_CATEGORIES);
	const promoted = new Set<number>();
	let campaigns = 0;
	for (let i = 0; i < scale.promotions; i++) {
		const campaignsLeft = CAMPAIGNS - campaigns;
		const campaign = order.next() < campaignsLeft / (scale.promotions - i);
		const row = campaign
			? campaignPromotion(campaigns, exclusiveCategories, campaignRng)
			: productPromotion(scale, counts, categoryOf, promoted, productRng);
		if (campaign) campaigns++;
		row.id = `promo-${pad(i, 4)}`;
		// Indexable eligibility keys.
		//
		// `tiers: []` means "no restriction on tier", which no index can match — a probe for
		// `tiers = 'gold'` can never return it. That is why the first indexed implementation
		// silently lost 14% of the corpus and had to be replaced by a full scan. The sentinel
		// makes "unrestricted" an indexable value like any other, so one `in` probe covers
		// both "matches this tier" and "applies to every tier".
		row.tierKeys = (row.tiers as string[]).length ? row.tiers : [UNRESTRICTED];
		row.categoryKeys = (row.categoryIds as string[]).length ? row.categoryIds : [UNRESTRICTED];
		yield row;
	}
}

function campaignPromotion(n: number, exclusiveCategories: string[], rng: Rng): Record<string, unknown> {
	if (n < exclusiveCategories.length) {
		return {
			kind: 'exclusive',
			tiers: [EXCLUSIVE_TIERS[n % EXCLUSIVE_TIERS.length]],
			skus: [],
			categoryIds: [exclusiveCategories[n]],
			thresholdMinor: rng.int(15_000, 40_000),
			amountMinor: 0,
			amountBasisPoints: rng.int(1_500, 3_000),
		};
	}
	const kind = rng.weighted([['stackable', 50], ['threshold', 25], ['bogo', 25]] as const);
	// Cart-wide thresholds are narrow, scoped to a tier AND a category. Storewide promotions are
	// rare: a probe for an unrestricted row returns it for every cart.
	const narrow = kind === 'threshold';
	const row: Record<string, unknown> = {
		kind,
		tiers: narrow || rng.chance(0.78) ? [rng.pick(TIERS)] : [],
		skus: [],
		categoryIds: narrow || !rng.chance(0.08) ? [rng.pick(CATEGORIES)] : [],
		thresholdMinor: kind === 'threshold' ? rng.int(8_000, 40_000) : 0,
		amountMinor: 0,
		amountBasisPoints: 0,
	};
	if (kind === 'bogo') {
		row.amountBasisPoints = 10000; // the free unit
	} else if (rng.chance(0.75)) {
		row.amountBasisPoints = rng.int(500, 1_500);
	} else {
		// Fixed-amount promotions carry a MINIMUM SPEND. Without one, a 1,644-minor discount
		// landed on a 1,325-minor cart and priced it to zero — the engine capping at the
		// subtotal correctly, against data no real store would publish.
		row.amountMinor = rng.int(200, 3_000);
		row.thresholdMinor = (row.amountMinor as number) * rng.int(4, 10);
	}
	return row;
}

function productPromotion(scale: Scale, counts: number[], categoryOf: Uint8Array, promoted: Set<number>, rng: Rng): Record<string, unknown> {
	// Collisions are redrawn, as cart lines are; past 16 draws the next unpromoted product in id
	// order is taken, so the row count never depends on luck.
	let productIndex = -1;
	for (let attempt = 0; attempt < 16 && productIndex < 0; attempt++) {
		const candidate = scramble(rng.zipfRank(scale.products), scale.products);
		if (!promoted.has(candidate)) productIndex = candidate;
	}
	if (productIndex < 0) {
		productIndex = 0;
		while (promoted.has(productIndex)) productIndex++;
	}
	promoted.add(productIndex);
	const kind = rng.weighted([['stackable', 75], ['bogo', 25]] as const);
	return {
		kind,
		tiers: rng.chance(0.3) ? [rng.pick(TIERS)] : [],
		skus: Array.from({ length: counts[productIndex] }, (_, v) => sku(productIndex, v)),
		categoryIds: [CATEGORIES[categoryOf[productIndex]]],
		thresholdMinor: 0,
		amountMinor: 0,
		amountBasisPoints: kind === 'bogo' ? 10000 : rng.int(500, 2_500),
	};
}

export function* rates(): Generator<Record<string, unknown>> {
	// Deterministic by construction — no PRNG. Rates are a lookup table, not sampled data.
	const bands = [
		[0, 1_000, 499],
		[1_001, 5_000, 899],
		[5_001, 20_000, 1_499],
		// Int is int32 in the schema, so the open-ended top band uses a large in-range sentinel
		// rather than MAX_SAFE_INTEGER, which Harper rejects at write time.
		[20_001, 2_000_000_000, 2_499],
	] as const;
	for (const region of REGIONS) {
		const surcharge = region.startsWith('us') ? 0 : 400;
		for (const [min, max, amount] of bands) {
			yield {
				id: `ship-${region}-${min}`, kind: 'shipping', region,
				weightMin: min, weightMax: max, jurisdiction: '',
				amountMinor: amount + surcharge, basisPoints: 0,
			};
		}
	}
	const tax: Record<string, number> = {
		'us-ny': 888, 'us-ca': 975, 'us-tx': 825, 'eu-de': 1900, 'eu-fr': 2000, 'apac-jp': 1000,
	};
	for (const jurisdiction of JURISDICTIONS) {
		yield {
			id: `tax-${jurisdiction}`, kind: 'tax', region: '',
			weightMin: 0, weightMax: 0, jurisdiction,
			amountMinor: 0, basisPoints: tax[jurisdiction],
		};
	}
}

/** What the cart generator actually drew, so the manifest states measured mass, not intent. */
export interface CartLineStats {
	lines: number;
	/** Lines whose product is among the hottest `headShare` of ranks. */
	headLines: number;
	/** Lines on the single hottest product. */
	topLines: number;
}

export function* carts(scale: Scale, counts: number[], rng: Rng, headShare: number, stats: CartLineStats): Generator<Record<string, unknown>> {
	const headRanks = Math.floor(scale.products * headShare);
	for (let i = 0; i < scale.carts; i++) {
		const size = rng.weighted(CART_SIZE);
		const lines: { sku: string; quantity: number }[] = [];
		const seen = new Set<string>();
		for (let l = 0; l < size; l++) {
			// Skewed toward a hot subset of the catalog: this is the access pattern the read
			// workload and the background writer must share for cache-hit rate to mean anything.
			//
			// Collisions are REDRAWN, not dropped. Dropping them made carts systematically
			// smaller than the declared CART_SIZE distribution — and the stronger the skew, the
			// more collisions, so the drift grew exactly as the hot set got hotter (mean 3.30
			// lines against a declared 3.81). Cart size drives the quote's fan-out, which is the
			// primary measured endpoint, so the manifest has to describe the data it ships.
			let s: string | null = null;
			let rank = -1;
			for (let attempt = 0; attempt < 16 && s === null; attempt++) {
				rank = rng.zipfRank(scale.products);
				// Scrambled, so the hot products are spread across the catalog rather than being
				// its lowest ids — the same mapping the harness uses for reads and writes.
				const productIndex = scramble(rank, scale.products);
				const variantIndex = rng.int(0, counts[productIndex] - 1);
				const candidate = sku(productIndex, variantIndex);
				if (!seen.has(candidate)) s = candidate;
			}
			// A cart that genuinely cannot find a distinct SKU in 16 draws keeps the lines it
			// has; at every scale here that is vanishingly rare, and the alternative is an
			// unbounded loop.
			if (s === null) break;
			seen.add(s);
			stats.lines++;
			if (rank < headRanks) stats.headLines++;
			if (rank === 0) stats.topLines++;
			lines.push({ sku: s, quantity: rng.weighted([[1, 60], [2, 22], [3, 10], [5, 6], [10, 2]] as const) });
		}
		yield { id: cartId(i), customerId: customerId(rng.int(0, scale.customers - 1)), lines };
	}
}
