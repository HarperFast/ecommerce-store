/**
 * The access distribution — part of the benchmark contract, not a harness detail.
 *
 * Every implementation must be driven by the SAME distribution, and the dataset must be
 * built against it, or the two disagree about what is hot. Hence this lives in the spec
 * package: `packages/seed` builds carts with it and `bench/` issues requests with it.
 *
 * Why it matters: a uniform access pattern over a large key space means a cache is almost
 * never asked for the same key twice, and neither caching nor cache coherence can be measured.
 * A pattern that sends a fifth of all traffic to one key measures that key instead.
 */

/**
 * The shape: a discrete Zipf over rank, `P(rank k) = (k + 1) ** -s / H(n, s)` for k in
 * [0, n), where H is the generalized harmonic number. One exponent for every key space.
 *
 * The exponent is DERIVED, not chosen: it is the `s` at which the hottest 1% of the bench
 * catalog (20,000 of 2,000,000 products) takes exactly half the draws. Solved numerically,
 * s = 0.88446; stated to four places. At that `s` the hottest single key takes 2.62% of
 * product draws and 3.44% of cart draws (n = 300,000).
 *
 * The continuous power law this replaces stated the same head — 1% of keys, half the
 * traffic — but floor(n * u ** 6.64) put (1/n) ** (1/6.64) of all draws on index 0: 22.5% of
 * every product read, quote and write at n = 20,000. The workload was partly a benchmark of
 * one row.
 */
export interface AccessSkew {
	/** Fraction of the key space that is "hot". */
	headShare: number;
	/** Fraction of all draws that land in it, at `catalogSize`. */
	headMass: number;
	/** The key-space size the exponent was solved at: the bench catalog. */
	catalogSize: number;
	/** The Zipf exponent `s` solving the head claim at `catalogSize`, to four places. */
	exponent: number;
}

export const ACCESS_SKEW: AccessSkew = { headShare: 0.01, headMass: 0.5, catalogSize: 2_000_000, exponent: 0.8845 };

/**
 * The cumulative distribution over rank, built once per key-space size. Inversion against it
 * is exact to float64 and costs a binary search: 21 probes at n = 2,000,000, 16 MB per size.
 */
const cdfs = new Map<number, Float64Array>();
function zipfCdf(n: number, s = ACCESS_SKEW.exponent): Float64Array {
	const key = n + s * 1e-9;
	let cdf = cdfs.get(key);
	if (!cdf) {
		cdf = new Float64Array(n);
		let total = 0;
		for (let k = 0; k < n; k++) cdf[k] = total += Math.pow(k + 1, -s);
		for (let k = 0; k < n; k++) cdf[k] /= total;
		cdfs.set(key, cdf);
	}
	return cdf;
}

/** Map a uniform `u` in [0, 1) to a Zipf rank in [0, n): rank 0 is the hottest key. */
export function zipfRank(u: number, n: number): number {
	if (n <= 1) return 0;
	const cdf = zipfCdf(n);
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (u < cdf[mid]) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** The exact share of draws on the hottest `k` ranks of an `n`-key space. */
export function zipfMass(n: number, k: number): number {
	if (k <= 0) return 0;
	return k >= n ? 1 : zipfCdf(n)[k - 1];
}

/**
 * The scramble: a fixed bijection of [0, n) that spreads hot ranks across the key space, as
 * YCSB's scrambled Zipfian does. Without it rank r was key r, so the hot set was the lowest
 * ids — one contiguous run of product rows, carts and SKUs, which flatters any storage engine
 * that keeps neighbouring keys together.
 *
 * A four-round Feistel network over the smallest even-width power of two at least n, walked
 * until it lands inside [0, n). Each round key is FNV-1a of `SCRAMBLE_SEED:<round>`, mixed
 * with the lowbias32 integer hash. Pure 32-bit integer arithmetic, so any runtime reproduces
 * it; nothing to store.
 */
export const SCRAMBLE_SEED = 'ecommerce-store-scramble-v1';

function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
function lowbias32(x: number): number {
	x ^= x >>> 16;
	x = Math.imul(x, 0x7feb352d);
	x ^= x >>> 15;
	x = Math.imul(x, 0x846ca68b);
	x ^= x >>> 16;
	return x >>> 0;
}
const ROUND_KEYS = [0, 1, 2, 3].map((round) => fnv1a(`${SCRAMBLE_SEED}:${round}`));

export function scramble(rank: number, n: number): number {
	if (n <= 1) return 0;
	let bits = Math.max(2, Math.ceil(Math.log2(n)));
	if (bits % 2) bits++;
	const half = bits / 2;
	const size = 2 ** half;
	const mask = size - 1;
	let x = rank;
	do {
		let left = Math.floor(x / size);
		let right = x & mask;
		for (const key of ROUND_KEYS) {
			const next = (left ^ (lowbias32(right ^ key) & mask)) >>> 0;
			left = right;
			right = next;
		}
		x = left * size + right;
	} while (x >= n);
	return x;
}

/**
 * Map a uniform `u` in [0, 1) to a key index in [0, n): a Zipf rank, scrambled.
 *
 * Shared verbatim by the generator and the harness, so the dataset's hot products and the
 * workload's hot products are the same products.
 */
export function zipfIndex(u: number, n: number): number {
	return scramble(zipfRank(u, n), n);
}

/**
 * The fixed warm-up before every measured ladder, by dataset scale. The run lifecycle requires
 * it to be identical in volume and key distribution for every target: it is drawn from the same
 * request stream as the ladder, so only its length and rate are set here.
 *
 * `bench`: 120,000 requests at 100 rps, about 20 minutes. At 100 rps from a cold page cache the
 * Harper target filled 87% of its 2 GiB in 10 minutes and was still rising about 26 MiB a
 * minute, so 20 minutes brings a target to its memory budget before anything is measured;
 * a short warm-up measured a cache still filling. `dev` fits in memory and only needs its
 * caches loaded.
 */
export const WARMUP: Readonly<Record<string, { requests: number; rate: number }>> = {
	bench: { requests: 120_000, rate: 100 },
	dev: { requests: 2_000, rate: 200 },
};

/**
 * What a published (`bench`) run must use beyond the warm-up; verify-run-record.mjs fails a
 * `bench` record without it, and the harness and orchestrator default to it at that scale.
 *
 * - `minStepSeconds`: tier 2 samples cycles every 250 ms, so a step boundary can misattribute
 *   up to one interval at each end: up to ~3% of a 15 s step, under 1% of a 60 s one.
 * - `arrivals`: seeded Poisson arrivals. Evenly spaced arrivals never bunch, so they understate
 *   queueing against real traffic at the same utilization. The seed is fixed per step, so every
 *   target is offered the same arrival times.
 */
export const PUBLISHED_RUN: Readonly<{ minStepSeconds: number; arrivals: 'poisson' | 'uniform' }> = {
	minStepSeconds: 60,
	arrivals: 'poisson',
};

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

/**
 * The sentinel meaning "unrestricted on this dimension".
 *
 * An empty eligibility array means a promotion applies to every value of that dimension —
 * and an empty array is exactly what an index cannot match. Storing the sentinel alongside
 * the real values turns "unrestricted" into an indexable value, so a single `in` probe
 * covers both cases. Part of the spec rather than the implementation because any stack
 * hitting this needs the same trick (a Postgres implementation indexes the same sentinel,
 * or uses a partial index; either way the data has to carry it).
 */
export const UNRESTRICTED = '*' as const;
