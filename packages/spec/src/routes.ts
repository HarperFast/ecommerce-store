/**
 * The route contract — SPEC.md §5 and §6.
 *
 * Canonical paths and their parameter grammar. An implementation whose platform idiom
 * differs (PostgREST, for example) may serve equivalent paths, but MUST then publish a
 * mapping the verification suite is configured with — see `RouteMapping`.
 */

import type { ProductDetail, ProductListing } from './model.ts';

export const SORTS = ['relevance', 'price_asc', 'price_desc', 'newest', 'name_asc'] as const;
export type Sort = (typeof SORTS)[number];

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 96;
/** Listing default; search defaults to `relevance`. */
export const DEFAULT_SORT: Sort = 'name_asc';

export interface ListingQuery {
	/** Category slug. Includes descendants — PLP-001. */
	category?: string;
	/** 1-based. */
	page?: number;
	pageSize?: number;
	sort?: Sort;
	/** facet name → selected values. OR within, AND across — PLP-004. */
	facets?: Record<string, string[]>;
	inStock?: boolean;
}

export interface SearchQuery extends ListingQuery {
	/** Non-empty after trimming, or 400 — SRCH-003. */
	q: string;
}

/** Canonical data API paths — profile DATA. */
export const API = {
	products: '/api/catalog/products',
	product: (slug: string) => `/api/catalog/products/${encodeURIComponent(slug)}`,
	search: '/api/catalog/search',
	adminVariant: (sku: string) => `/api/admin/variants/${encodeURIComponent(sku)}`,
	adminVariantsBulk: '/api/admin/variants/bulk',
} as const;

/** Canonical page paths — profile APP. */
export const PAGES = {
	home: '/',
	category: (path: string[]) => `/c/${path.map(encodeURIComponent).join('/')}`,
	product: (slug: string) => `/p/${encodeURIComponent(slug)}`,
	search: '/search',
	cart: '/cart',
	checkout: '/checkout',
	account: '/account',
	orders: '/account/orders',
} as const;

/**
 * Serialize a listing query to canonical search params. Shared so every implementation and
 * the verification suite agree byte-for-byte on what a given query URL is — API-004's stable
 * ordering is meaningless if two clients spell the same query differently.
 *
 * Facet keys are emitted sorted, and values sorted within a key, so the same logical query
 * always produces the same URL (and therefore the same cache key).
 */
export function listingSearchParams(query: ListingQuery & { q?: string }): URLSearchParams {
	const params = new URLSearchParams();
	if (query.q !== undefined) params.set('q', query.q);
	if (query.category !== undefined) params.set('category', query.category);
	if (query.page !== undefined) params.set('page', String(query.page));
	if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
	if (query.sort !== undefined) params.set('sort', query.sort);
	if (query.inStock) params.set('inStock', 'true');
	for (const name of Object.keys(query.facets ?? {}).sort()) {
		for (const value of [...(query.facets![name] ?? [])].sort()) {
			params.append(`facet.${name}`, value);
		}
	}
	return params;
}

/** Parse the `facet.<name>=<value>` form back into the grouped shape. */
export function parseFacetParams(params: URLSearchParams): Record<string, string[]> {
	const facets: Record<string, string[]> = {};
	for (const [key, value] of params) {
		if (!key.startsWith('facet.')) continue;
		const name = key.slice('facet.'.length);
		if (!name) continue;
		(facets[name] ??= []).push(value);
	}
	return facets;
}

/**
 * Clamp rather than error — API-005. Returns the effective page/pageSize for any input,
 * including garbage, so every implementation clamps identically.
 */
export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
	const p = Number.isInteger(page) && page! >= 1 ? page! : 1;
	const raw = Number.isInteger(pageSize) && pageSize! >= 1 ? pageSize! : DEFAULT_PAGE_SIZE;
	return { page: p, pageSize: Math.min(raw, MAX_PAGE_SIZE) };
}

/**
 * A non-canonical implementation declares its paths here, and the verification suite is
 * configured with it — SPEC.md §5. The mapping is published as part of the comparison.
 */
export interface RouteMapping {
	implementation: string;
	profile: 'DATA' | 'APP';
	rewrite(canonicalPath: string): string;
}

export type { ProductDetail, ProductListing };
