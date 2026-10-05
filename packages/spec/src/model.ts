/**
 * Domain model — SPEC.md §3.
 *
 * Stack-neutral. These types describe what crosses the wire, never how anything is stored.
 * If a type here could not be produced by Fastify + Postgres + Redis, it is mis-specified.
 */

/** Money is ALWAYS integer minor units (cents) — SPEC.md DATA-002. Never a float. */
export type Minor = number;

export interface Cart {
	id: string;
	customerId: string;
	lines: CartLine[];
}

export interface CartLine {
	sku: string;
	quantity: number;
}

export interface Customer {
	id: string;
	tier: string;
	loyaltyBalance: Minor;
	region: string;
	taxJurisdiction: string;
}

export interface Product {
	id: string;
	title: string;
	categoryIds: string[];
	/** Grams. Summed across lines for shipping — QUOTE-006. */
	weight: number;
	/** Fan out to further product reads — see the §3 foldings. */
	relatedProductIds: string[];
	reviewRollup: ReviewRollup;
}

export interface ReviewRollup {
	count: number;
	/** Hundredths of a star, so no float enters the model. */
	averageCentistars: number;
}

export interface Variant {
	sku: string;
	productId: string;
	options: Record<string, string>;
	basePrice: Minor;
	weight: number;
}

export interface Inventory {
	sku: string;
	locationId: string;
	onHand: number;
}

export interface Location {
	id: string;
	region: string;
	/** Lower wins when resolving availability — QUOTE-003. */
	priority: number;
}

export type PromotionKind = 'exclusive' | 'threshold' | 'bogo' | 'stackable';

export interface Promotion {
	id: string;
	kind: PromotionKind;
	/** Eligibility. An empty array means "no restriction on this dimension". */
	tiers: string[];
	skus: string[];
	categoryIds: string[];
	/** For `threshold`: minimum pre-discount subtotal. */
	thresholdMinor?: Minor;
	/** Discount, in minor units or basis points; exactly one is set. */
	amountMinor?: Minor;
	amountBasisPoints?: number;
}

export type RateKind = 'shipping' | 'tax';

export interface Rate {
	id: string;
	kind: RateKind;
	/** shipping: region + weight band. tax: jurisdiction. */
	region?: string;
	weightMin?: number;
	weightMax?: number;
	jurisdiction?: string;
	amountMinor?: Minor;
	basisPoints?: number;
}

// --- responses ---------------------------------------------------------------

export interface QuoteLine {
	sku: string;
	quantity: number;
	/** After tier resolution, before promotions. */
	unitPrice: Minor;
	appliedPromotionIds: string[];
	lineTotal: Minor;
}

/** SPEC.md QUOTE-010. Deterministic for a given cart and dataset state — QUOTE-008. */
export interface Quote {
	cartId: string;
	/** Applied to pricing — QUOTE-004. */
	tier: string;
	/** Read and carried, not redeemed — QUOTE-004 and docs/future-work.md. */
	loyaltyBalance: Minor;
	region: string;
	taxJurisdiction: string;
	totalWeight: number;
	lines: QuoteLine[];
	subtotal: Minor;
	discountTotal: Minor;
	shipping: Minor;
	tax: Minor;
	grandTotal: Minor;
	currency: string;
}

/** SPEC.md §5. Varies by tier and region — PDP-002. */
export interface ProductAggregate {
	product: Product;
	variants: Variant[];
	/** Per sku, aggregated across locations in the requested region. */
	availability: Record<string, number>;
	/** Per sku, resolved for the requested tier. */
	resolvedPrice: Record<string, Minor>;
	/** Abbreviated on purpose — enough to render a related-items strip without a further request (PDP-005). */
	related: Pick<Product, 'id' | 'title' | 'reviewRollup'>[];
	tier: string;
	region: string;
}

export interface ApiError {
	error: { code: string; message: string };
}
