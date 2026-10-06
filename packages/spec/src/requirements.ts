/**
 * The requirement registry — the machine-readable index of SPEC.md.
 *
 * Every test in the verification suite names the requirement ids it covers, and every MUST
 * must be covered by at least one test (SPEC.md, "Conformance"). `coverageGaps()` makes that checkable
 * rather than aspirational.
 *
 * Ids are PERMANENT. Withdraw a requirement by setting `withdrawn: true`; never reuse an id.
 */

export type Level = 'MUST' | 'SHOULD' | 'MAY';
export type Area = 'DATA' | 'CACHE' | 'QUOTE' | 'PDP' | 'WRITE' | 'OBS';

export interface Requirement {
	id: string;
	area: Area;
	level: Level;
	/** One line, matching SPEC.md. The spec text is normative; this is the index. */
	summary: string;
	withdrawn?: boolean;
}

const r = (id: string, area: Area, level: Level, summary: string): Requirement => ({ id, area, level, summary });

export const REQUIREMENTS: readonly Requirement[] = [
	// Data model
	r('DATA-001', 'DATA', 'MUST', 'Exactly the eight logical entities; a differing representation is documented, never pre-joined'),
	r('DATA-002', 'DATA', 'MUST', 'Money is integer minor units end to end'),
	r('DATA-003', 'DATA', 'MUST', 'Every implementation loads the same versioned dataset, checksum-verified'),
	r('DATA-004', 'DATA', 'MUST', 'One dataset size, with a working set that does not fit in memory'),
	r('DATA-005', 'DATA', 'MUST', 'The dataset is generated deterministically and version controlled'),

	// Caching — derived, bounded, correctly keyed.
	r('CACHE-001', 'CACHE', 'MUST', 'Caches are derived: dropping every cache changes no response body, only latency'),
	r('CACHE-002', 'CACHE', 'MUST', 'Every cached value is bounded by FRESH_MS, by invalidation or expiry, and says which'),
	r('CACHE-003', 'CACHE', 'MUST', 'A cache key includes every dimension the cached value varies by'),

	// POST /cart/:id/quote
	r('QUOTE-001', 'QUOTE', 'MUST', 'Every response is unique to its cart; response-level caching is a conformance failure'),
	r('QUOTE-002', 'QUOTE', 'MUST', 'Each line resolves product and variant; an unknown sku fails the quote with 400'),
	r('QUOTE-003', 'QUOTE', 'MUST', 'Availability resolves against inventory across locations, honouring priority'),
	r('QUOTE-004', 'QUOTE', 'MUST', 'Customer tier is applied to pricing; loyalty balance is read and carried in the response'),
	r('QUOTE-005', 'QUOTE', 'MUST', 'Promotions resolve by tier, SKU and category and evaluate stacking, exclusivity, threshold and BOGO'),
	r('QUOTE-006', 'QUOTE', 'MUST', 'Shipping resolves by region and total cart weight'),
	r('QUOTE-007', 'QUOTE', 'MUST', 'Tax resolves by jurisdiction and applies to the post-discount subtotal'),
	r('QUOTE-008', 'QUOTE', 'MUST', 'The quote is deterministic for a given cart and dataset state'),
	r('QUOTE-009', 'QUOTE', 'MUST', 'An unknown cart id returns 404'),
	r('QUOTE-010', 'QUOTE', 'MUST', 'The response itemizes per line and at cart level'),
	r('QUOTE-011', 'QUOTE', 'MUST', 'Cart-wide and BOGO promotions apply once per cart, stackables once per eligible line (max 3); discountTotal in [0, 60% of subtotal]'),
	r('QUOTE-012', 'QUOTE', 'MUST', 'appliedPromotionIds lists exactly the promotions that discounted that line'),

	// GET /product/:id
	r('PDP-001', 'PDP', 'MUST', 'Aggregates product, variants, inventory, resolved price, review rollup and related items'),
	r('PDP-002', 'PDP', 'MUST', 'Price varies by tier and availability by region; both are in any cache key'),
	r('PDP-003', 'PDP', 'MUST', 'Inventory and price reflect background writes within FRESH_MS'),
	r('PDP-004', 'PDP', 'MUST', 'An unknown product id returns 404'),
	r('PDP-005', 'PDP', 'SHOULD', 'Related items carry enough detail to render without a further request'),

	// Background writes
	r('WRITE-001', 'WRITE', 'MUST', 'A steady writer updates inventory and prices within the read working set'),
	r('WRITE-002', 'WRITE', 'MUST', 'A committed write is observable on the aggregate and in quote pricing within FRESH_MS'),
	r('WRITE-003', 'WRITE', 'MUST', 'Coherence is not satisfied by disabling caching; cache-hit rates are recorded'),
	r('WRITE-004', 'WRITE', 'MUST', 'The write stream is identical in rate and key distribution for every target'),

	// Observability
	r('OBS-001', 'OBS', 'MUST', 'Both endpoints emit Server-Timing decomposing data access, compute and total'),
	r('OBS-002', 'OBS', 'MUST', 'Responses indicate cache status and the mechanism is documented'),
	r('OBS-003', 'OBS', 'MUST', 'Instrumentation exists from the first commit of a surface'),
] as const;

const BY_ID = new Map(REQUIREMENTS.map((req) => [req.id, req]));

export function requirement(id: string): Requirement {
	const found = BY_ID.get(id);
	if (!found) throw new Error(`Unknown requirement id: ${id}`);
	return found;
}

export function activeRequirements(): Requirement[] {
	return REQUIREMENTS.filter((req) => !req.withdrawn);
}

/**
 * Every MUST must be covered by at least one test. Returns the uncovered ids, which is what
 * CI asserts is empty.
 */
export function coverageGaps(coveredIds: Iterable<string>): string[] {
	const covered = new Set(coveredIds);
	return activeRequirements()
		.filter((req) => req.level === 'MUST' && !covered.has(req.id))
		.map((req) => req.id);
}
