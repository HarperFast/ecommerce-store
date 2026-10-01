/**
 * The dataset generator — SPEC.md §3, docs/seed-design.md.
 *
 * Yields rows table by table so the output streams: the benchmark dataset is deliberately
 * larger than memory, and holding it all before writing would force every implementation to
 * solve a problem the benchmark is not about.
 *
 * Determinism rules (docs/seed-design.md): one seeded PRNG consumed in a fixed order, ids
 * derived rather than drawn, no wall clock, integer minor units only.
 */
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

export function* products(scale: Scale, counts: number[], rng: Rng): Generator<Record<string, unknown>> {
	for (let i = 0; i < scale.products; i++) {
		const categoryIndex = rng.int(0, CATEGORIES.length - 1);
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

export function* promotions(scale: Scale, rng: Rng): Generator<Record<string, unknown>> {
	for (let i = 0; i < scale.promotions; i++) {
		// Exclusives short-circuit everything, so they stay genuinely rare: at 8% they reached
		// 78% of carts, because a category-scoped exclusive matches any cart containing that
		// category and carts span several.
		const kind = rng.weighted([['stackable', 46], ['threshold', 26], ['bogo', 25], ['exclusive', 3]] as const);

		// Exclusive promotions SHORT-CIRCUIT the whole evaluation: if one applies, nothing else
		// does. An earlier corpus gave every tier unrestricted exclusives, so every non-empty
		// cart took that branch and threshold, BOGO and stackable were never evaluated at all —
		// three of the four advertised pricing phases absent from the measured path. Exclusives
		// are therefore rare AND always narrowly scoped.
		// Exclusives are scoped by CATEGORY only, not category AND tier. Doubly-restricting them
		// made them unreachable: a sweep of 150 dev carts applied zero exclusives and zero
		// BOGOs, so two of the four pricing phases were dead in the workload. A phase that
		// never fires is a phase the benchmark does not measure, which is the same defect as
		// exclusives firing on everything — just in the other direction.
		const narrow = kind === 'exclusive';
		const byCategory = narrow || rng.chance(0.55);
		const row: Record<string, unknown> = {
			id: `promo-${pad(i, 4)}`,
			kind,
			tiers: narrow ? [] : rng.chance(0.5) ? [rng.pick(TIERS)] : [],
			skus: [],
			categoryIds: byCategory ? [rng.pick(CATEGORIES)] : [],
			thresholdMinor: kind === 'threshold' ? rng.int(5_000, 40_000) : 0,
			amountMinor: 0,
			amountBasisPoints: 0,
		};
		if (kind === 'bogo') {
			row.amountBasisPoints = 10000; // the free unit
		} else if (rng.chance(0.75)) {
			row.amountBasisPoints = rng.int(500, 2_500);
		} else {
			// Fixed-amount promotions carry a MINIMUM SPEND. Without one, a 1,644-minor discount
			// landed on a 1,325-minor cart and priced it to zero — the engine capping at the
			// subtotal correctly, against data no real store would publish.
			row.amountMinor = rng.int(200, 3_000);
			row.thresholdMinor = (row.amountMinor as number) * rng.int(4, 10);
		}
		yield row;
	}
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

export function* carts(scale: Scale, counts: number[], rng: Rng): Generator<Record<string, unknown>> {
	for (let i = 0; i < scale.carts; i++) {
		const size = rng.weighted(CART_SIZE);
		const lines: { sku: string; quantity: number }[] = [];
		const seen = new Set<string>();
		for (let l = 0; l < size; l++) {
			// Skewed toward a hot subset of the catalog: this is the access pattern the read
			// workload and the background writer must share for cache-hit rate to mean anything.
			const productIndex = rng.skewed(scale.products);
			const variantIndex = rng.int(0, counts[productIndex] - 1);
			const s = sku(productIndex, variantIndex);
			if (seen.has(s)) continue;
			seen.add(s);
			lines.push({ sku: s, quantity: rng.weighted([[1, 60], [2, 22], [3, 10], [5, 6], [10, 2]] as const) });
		}
		yield { id: cartId(i), customerId: customerId(rng.int(0, scale.customers - 1)), lines };
	}
}
