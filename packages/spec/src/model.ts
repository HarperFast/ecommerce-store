/**
 * Domain model — SPEC.md §4.
 *
 * Platform-neutral. These types describe what crosses the wire, never how anything is
 * stored. If a type here could not be produced by a Postgres implementation, it is
 * mis-specified.
 */

/** Money is ALWAYS integer minor units (cents) — SPEC.md CAT-004. Never a float. */
export type Minor = number;

/** Epoch milliseconds. Deterministic per seed — SPEC.md SEED-001. */
export type EpochMs = number;

export interface Category {
	id: string;
	slug: string;
	name: string;
	parentId: string | null;
	/** Ancestor slugs, root first, excluding self. */
	path: string[];
	/** `path.length`. */
	depth: number;
}

/** Ordered axis of the variant matrix, e.g. `{ name: 'size', values: ['S','M','L'] }`. */
export interface OptionAxis {
	name: string;
	values: string[];
}

export interface Product {
	id: string;
	slug: string;
	title: string;
	description: string;
	brand: string;
	categoryIds: string[];
	optionAxes: OptionAxis[];
	/** Flat, facetable. */
	attributes: Record<string, string>;
	createdAt: EpochMs;
}

/** The purchasable unit. */
export interface Variant {
	sku: string;
	productId: string;
	/** Exactly one entry per axis of the parent product — SPEC.md CAT-001. */
	options: Record<string, string>;
	price: Minor;
	/** ISO 4217. `USD` for v1. */
	currency: string;
	stock: number;
	/** Deterministic input to placeholder media — SPEC.md SEED-006. */
	imageSeed: string;
}

/**
 * The projection returned by listing and search. Carries the product-level aggregates over
 * variants, which MUST be consistent with current variants at response time — SPEC.md
 * CAT-003. How they are kept consistent is deliberately unspecified; that is the finding.
 */
export interface ProductSummary {
	id: string;
	slug: string;
	title: string;
	brand: string;
	priceMin: Minor;
	priceMax: Minor;
	/** True iff ANY variant has stock > 0. */
	inStock: boolean;
	/** Distinct values of the `color` axis in declared order; `[]` when there is none. */
	swatches: string[];
	variantCount: number;
	imageSeed: string;
}

/** Product detail — SPEC.md §5.3. Every variant, with live stock. */
export interface ProductDetail extends Product {
	variants: Variant[];
}

export interface FacetValue {
	value: string;
	count: number;
}

export interface Facet {
	name: string;
	values: FacetValue[];
}

export interface Page<T> {
	items: T[];
	/** 1-based. */
	page: number;
	pageSize: number;
	/** Exact, never estimated, never capped — SPEC.md PLP-002. */
	total: number;
}

export interface ProductListing extends Page<ProductSummary> {
	facets: Facet[];
}

export interface ApiError {
	error: { code: string; message: string };
}

/** Segment-keyed personalization — SPEC.md §9.4. */
export type SegmentId = string;
