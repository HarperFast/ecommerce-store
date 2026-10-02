/**
 * Deterministic pseudo-randomness — SPEC.md DATA-005.
 *
 * mulberry32: small, fast, well-distributed, and trivially portable, which matters because
 * the dataset's reproducibility is an auditable claim. Seeded from a string so a run is
 * named by something human-readable rather than a magic integer.
 *
 * NOTHING in generation may use Math.random, Date.now, or crypto randomness.
 */

import { skewedIndex } from '@ecommerce-store/spec';

/** FNV-1a, so a seed string maps to a 32-bit state deterministically across runtimes. */
function hashSeed(seed: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export class Rng {
	#state: number;

	constructor(seed: string) {
		this.#state = hashSeed(seed);
	}

	/** [0, 1) */
	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** Integer in [min, max]. */
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}

	pick<T>(items: readonly T[]): T {
		return items[this.int(0, items.length - 1)];
	}

	/** True with the given probability. */
	chance(probability: number): boolean {
		return this.next() < probability;
	}

	/**
	 * Draw from a weighted distribution: `[[value, weight], ...]`.
	 *
	 * Used for every shape that must not be uniform — cart size, variants per product,
	 * inventory spread. Uniform data is the easiest way to accidentally produce a flattering
	 * benchmark, because it makes caching and lookup artificially even.
	 */
	weighted<T>(table: readonly (readonly [T, number])[]): T {
		let total = 0;
		for (const [, weight] of table) total += weight;
		let roll = this.next() * total;
		for (const [value, weight] of table) {
			roll -= weight;
			if (roll < 0) return value;
		}
		return table[table.length - 1][0];
	}

	/**
	 * A skewed index into [0, n), using the shared access distribution.
	 *
	 * Delegates to `@ecommerce-store/spec` rather than defining its own curve: the dataset's
	 * hot products and the workload's hot products MUST be the same products, and two copies
	 * of a formula is how they stop being. The previous local version used an exponent of
	 * 1.1, which is very nearly uniform — it gave the top 1% of the catalog 1.52% of draws.
	 */
	skewed(n: number): number {
		return skewedIndex(this.next(), n);
	}
}
