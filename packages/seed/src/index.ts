/**
 * Dataset generation — SPEC.md, "Data model", designed in docs/seed-design.md.
 *
 * P0 declares the contract; the generator itself is P1.
 *
 * The dataset is generated ONCE here, committed, and checksummed. No implementation
 * re-derives it — identity is established by checksum, not by every runtime reproducing the
 * same PRNG stream.
 *
 * Dev-only package: every dependency added here MUST go in devDependencies, or it ships to
 * the node. See docs/structure.md.
 */

export const TABLES = [
	'cart',
	'customer',
	'product',
	'variant',
	'inventory',
	'location',
	'promotion',
	'rate',
] as const;
export type Table = (typeof TABLES)[number];

/** Fixed epoch for derived timestamps. No wall clock enters generation. 2026-01-01T00:00:00Z. */
export const EPOCH_MS = 1_767_225_600_000;

/**
 * Accompanies the committed dataset. Verified before every run; recorded with every
 * published result — SPEC.md DATA-003, DATA-005.
 */
export const GENERATOR_VERSION = '0.4.0' as const;

export interface DatasetManifest {
	specVersion: string;
	generatorVersion: string;
	/** Only `bench` is a valid benchmark target — SPEC.md DATA-004. */
	scale: string;
	seed: string;
	/** Files are stored `.ndjson.gz`; checksums are always over the UNCOMPRESSED bytes. */
	compressed: boolean;
	/** table → { sha256, rows } */
	files: Record<Table, { sha256: string; rows: number }>;
	/**
	 * Declared distributions, recorded so a published comparison can state them: cart size,
	 * variants per product, inventory spread across locations, promotion eligibility, and
	 * the access skew the read workload and background writer share.
	 */
	distributions: Record<string, unknown>;
}
