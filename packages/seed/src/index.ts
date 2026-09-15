/**
 * Deterministic corpus generation — SPEC.md §8, designed in docs/seed-design.md.
 *
 * P0 declares the contract; the generator itself is P1.
 *
 * The corpus is generated ONCE here and distributed as a checksummed artifact. No
 * implementation re-derives it — corpus identity is established by checksum, not by every
 * platform reproducing the same PRNG stream. See docs/seed-design.md for why.
 *
 * Dev-only package: every dependency added here MUST go in devDependencies, or it ships to
 * the node. See docs/structure.md.
 */

export const TIERS = ['sm', 'md', 'lg'] as const;
export type Tier = (typeof TIERS)[number];

export interface TierShape {
	products: number;
	/** Approximate; the exact count follows from the variant-count distribution. */
	variants: number;
	shoppers: number;
	purpose: string;
}

/** SPEC.md SEED-002. */
export const TIER_SHAPES: Record<Tier, TierShape> = {
	sm: { products: 1_000, variants: 2_500, shoppers: 100, purpose: 'local development, CI, e2e' },
	md: { products: 10_000, variants: 25_000, shoppers: 1_000, purpose: 'functional verification' },
	lg: { products: 50_000, variants: 100_000, shoppers: 100_000, purpose: 'benchmarks' },
};

/**
 * Fixed epoch for derived timestamps. No wall clock ever enters generation — SEED-001.
 * 2026-01-01T00:00:00Z.
 */
export const EPOCH_MS = 1_767_225_600_000;

export const ENTITY_FILES = ['categories', 'products', 'variants', 'shoppers'] as const;
export type EntityFile = (typeof ENTITY_FILES)[number];

/**
 * Accompanies every corpus. A comparison records the manifest hash it ran against, and an
 * importer verifies before loading — SEED-005.
 */
export interface CorpusManifest {
	specVersion: string;
	generatorVersion: string;
	tier: Tier;
	seed: string;
	/** file name → { sha256, lines } */
	files: Record<EntityFile, { sha256: string; lines: number }>;
	/** Declared distributions, recorded so a published comparison can state them. */
	distributions: Record<string, unknown>;
	/** Pinned KDF parameters used for the seeded shopper hashes — see docs/auth-design.md. */
	kdf: { algorithm: 'scrypt'; N: number; r: number; p: number; keylen: number };
}
