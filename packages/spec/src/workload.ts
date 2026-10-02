/**
 * The access distribution — part of the benchmark contract, not a harness detail.
 *
 * Every implementation must be driven by the SAME distribution, and the dataset must be
 * built against it, or the two disagree about what is hot. Hence this lives in the spec
 * package: `packages/seed` builds carts with it and `bench/` issues requests with it.
 *
 * Why it matters: a uniform access pattern over a large key space means a cache is almost
 * never asked for the same key twice. The first version of this was a power law with an
 * exponent of 1.1, which is very nearly uniform — the top 1% of the catalog took 1.52% of
 * draws against 1% for uniform — while the manifest advertised "zipf-ish". Measured cache
 * hit rate was 2.5%, and with no hot set neither caching nor cache coherence can be
 * measured at all.
 */

/**
 * A power law over `[0, n)`, specified by its head rather than by an opaque exponent.
 *
 * The distribution is exactly `P(index < x * n) = x ** (1 / alpha)`, so stating the pair
 * (headShare, headMass) fully determines it and the claim is checkable by counting draws.
 * Deliberately NOT called Zipf: it is a continuous power law, not the discrete
 * `1 / k ** s` distribution, and naming it accurately costs nothing.
 */
export interface AccessSkew {
	/** Fraction of the key space that is "hot". */
	headShare: number;
	/** Fraction of all requests that land in it. */
	headMass: number;
}

/** 1% of the catalog takes half the traffic — a conventional cache-workload shape. */
export const ACCESS_SKEW: AccessSkew = { headShare: 0.01, headMass: 0.5 };

/** `alpha` such that `headShare ** (1 / alpha) === headMass`. */
export function skewExponent({ headShare, headMass }: AccessSkew = ACCESS_SKEW): number {
	return Math.log(headShare) / Math.log(headMass);
}

/**
 * Map a uniform `u` in [0, 1) onto a skewed index in [0, n).
 *
 * Shared verbatim by the generator and the harness so the dataset's hot products and the
 * workload's hot products are the same products.
 */
export function skewedIndex(u: number, n: number, skew: AccessSkew = ACCESS_SKEW): number {
	if (n <= 1) return 0;
	return Math.min(n - 1, Math.floor(n * Math.pow(u, skewExponent(skew))));
}

/**
 * Request-side tier and region weights.
 *
 * Tier mirrors the seeded customer population; drawing them uniformly made every tier
 * equally hot and multiplied the cached key space by four for no reason. Region is weighted
 * the same way for the same reason.
 */
export const TIER_WEIGHTS: readonly (readonly [string, number])[] = [
	['standard', 60], ['silver', 25], ['gold', 12], ['platinum', 3],
];

export const REGION_WEIGHTS: readonly (readonly [string, number])[] = [
	['us-east', 40], ['us-west', 25], ['eu-central', 25], ['apac', 10],
];

/** Pick from a weighted table using a uniform `u`. Deterministic for a given `u`. */
export function weightedPick<T>(table: readonly (readonly [T, number])[], u: number): T {
	let total = 0;
	for (const [, weight] of table) total += weight;
	let roll = u * total;
	for (const [value, weight] of table) {
		roll -= weight;
		if (roll < 0) return value;
	}
	return table[table.length - 1][0];
}
