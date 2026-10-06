/**
 * The route contract — SPEC.md, "POST /cart/:id/quote" and "GET /product/:id".
 *
 * Canonical paths. An implementation whose stack idiom differs MAY serve equivalent paths
 * and MUST then publish a mapping the verification suite is configured with.
 */

export const API = {
	/** POST — the primary endpoint under test. Never response-cacheable (QUOTE-001). */
	quote: (cartId: string) => `/cart/${encodeURIComponent(cartId)}/quote`,
	/** GET — varies by tier and region (PDP-002). */
	product: (productId: string) => `/product/${encodeURIComponent(productId)}`,
} as const;

export interface ProductQuery {
	tier: string;
	region: string;
}

/**
 * Serialize the product query canonically. Shared so two clients cannot spell the same
 * request differently — which would also mean two different cache keys for one logical
 * request, quietly changing a measured hit rate.
 */
export function productSearchParams({ tier, region }: ProductQuery): URLSearchParams {
	const params = new URLSearchParams();
	params.set('tier', tier);
	params.set('region', region);
	return params;
}

/** Promotion evaluation order — SPEC.md, "POST /cart/:id/quote". Normative: an unspecified order makes two correct implementations disagree on a total. */
export const PROMOTION_ORDER = ['exclusive', 'threshold', 'bogo', 'stackable'] as const;

/** A non-canonical implementation declares its paths here; published with the comparison. */
export interface RouteMapping {
	implementation: string;
	rewrite(canonicalPath: string): string;
}
