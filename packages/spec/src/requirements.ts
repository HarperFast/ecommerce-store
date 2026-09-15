/**
 * The requirement registry — the machine-readable index of SPEC.md.
 *
 * Every test in the shared verification suite names the requirement ids it covers, and
 * every MUST must be covered by at least one test (SPEC.md §11). `coverageGaps()` is what
 * makes that checkable rather than aspirational.
 *
 * Ids are PERMANENT. Withdraw a requirement by setting `withdrawn: true`; never reuse an id.
 */

export type Level = 'MUST' | 'SHOULD' | 'MAY';
export type Profile = 'DATA' | 'APP' | 'NATIVE';
export type Area =
	| 'CAT'
	| 'API'
	| 'PLP'
	| 'PDP'
	| 'SRCH'
	| 'ADM'
	| 'PAGE'
	| 'AUTH'
	| 'SEED'
	| 'OBS'
	| 'PERS'
	| 'CART'
	| 'RT';

export interface Requirement {
	id: string;
	area: Area;
	level: Level;
	profile: Profile;
	/** One line, matching SPEC.md. The spec text is normative; this is the index. */
	summary: string;
	/** Eligible to appear in a measured benchmark path — SPEC.md §9.1. */
	measured?: boolean;
	withdrawn?: boolean;
}

const r = (
	id: string,
	area: Area,
	level: Level,
	profile: Profile,
	summary: string,
	extra: Partial<Requirement> = {}
): Requirement => ({ id, area, level, profile, summary, ...extra });

export const REQUIREMENTS: readonly Requirement[] = [
	// §4.2 Catalog invariants
	r('CAT-001', 'CAT', 'MUST', 'DATA', 'Variant options cover exactly the product option axes, with declared values'),
	r('CAT-002', 'CAT', 'MUST', 'DATA', 'sku and Product.slug are globally unique'),
	r('CAT-003', 'CAT', 'MUST', 'DATA', 'ProductSummary aggregates are consistent with current variants at response time'),
	r('CAT-004', 'CAT', 'MUST', 'DATA', 'Prices are integer minor units end to end; no float money'),
	r('CAT-005', 'CAT', 'MUST', 'DATA', 'Every product has at least one variant'),
	r('CAT-006', 'CAT', 'SHOULD', 'DATA', 'A product belongs to at most one category per root subtree'),

	// §5.1 API conventions
	r('API-001', 'API', 'MUST', 'DATA', 'Unknown query parameters are ignored, not errored'),
	r('API-002', 'API', 'MUST', 'DATA', 'Malformed parameter values return 400 with the error envelope'),
	r('API-003', 'API', 'MUST', 'DATA', 'Missing resources return 404 with the error envelope'),
	r('API-004', 'API', 'MUST', 'DATA', 'Listing order is stable, with id/sku as final tiebreak'),
	r('API-005', 'API', 'MUST', 'DATA', 'Pagination is page/pageSize; default 24, max 96, clamped not errored'),
	r('API-006', 'API', 'SHOULD', 'DATA', 'Responses carry ETag and honour If-None-Match with 304'),

	// §5.2 Listing
	r('PLP-001', 'PLP', 'MUST', 'DATA', 'category selects the named category and all descendants', { measured: true }),
	r('PLP-002', 'PLP', 'MUST', 'DATA', 'total is exact, not estimated and not capped', { measured: true }),
	r('PLP-003', 'PLP', 'MUST', 'DATA', 'Facet counts are computed over the full filtered set, not the page', { measured: true }),
	r('PLP-004', 'PLP', 'MUST', 'DATA', 'Facet values OR within a facet, AND across facets', { measured: true }),
	r('PLP-005', 'PLP', 'MUST', 'DATA', "A facet's own counts exclude that facet's own selections", { measured: true }),
	r('PLP-006', 'PLP', 'MUST', 'DATA', 'inStock filtering and counts reflect live variant stock', { measured: true }),
	r('PLP-007', 'PLP', 'MUST', 'DATA', 'price_asc/price_desc sort on priceMin/priceMax respectively'),
	r('PLP-008', 'PLP', 'MUST', 'DATA', 'A page beyond the last returns 200 with an empty items array'),
	r('PLP-009', 'PLP', 'SHOULD', 'DATA', 'Facets offered: color, size, brand, material, inStock'),

	// §5.3 Detail
	r('PDP-001', 'PDP', 'MUST', 'DATA', 'Every variant is returned with live stock', { measured: true }),
	r('PDP-002', 'PDP', 'MUST', 'DATA', 'A stock write is reflected within FRESH_MS', { measured: true }),
	r('PDP-003', 'PDP', 'MUST', 'DATA', 'Unavailable variant combinations are marked, not omitted'),
	r('PDP-004', 'PDP', 'MUST', 'DATA', 'Unknown slug returns 404'),

	// §5.4 Search
	r('SRCH-001', 'SRCH', 'MUST', 'DATA', 'Full-text matching over title, brand and description', { measured: true }),
	r('SRCH-002', 'SRCH', 'MUST', 'DATA', 'Faceting and pagination behave as in listing, over the matched set', { measured: true }),
	r('SRCH-003', 'SRCH', 'MUST', 'DATA', 'Empty or whitespace-only q returns 400'),
	r('SRCH-004', 'SRCH', 'MUST', 'DATA', 'Matching is case- and diacritic-insensitive'),
	r('SRCH-005', 'SRCH', 'SHOULD', 'DATA', 'Multi-term queries are conjunctive'),
	r('SRCH-006', 'SRCH', 'MAY', 'DATA', 'Typo tolerance; if implemented it must be declared'),

	// §5.5 Admin writes
	r('ADM-001', 'ADM', 'MUST', 'DATA', 'Admin writes require the operator role; 401 then 403', { measured: true }),
	r('ADM-002', 'ADM', 'MUST', 'DATA', 'Writes visible within FRESH_MS on detail, FANOUT_MS on listing/facets', { measured: true }),
	r('ADM-003', 'ADM', 'MUST', 'DATA', 'Invalid stock/price returns 400 with no partial application'),
	r('ADM-004', 'ADM', 'MUST', 'DATA', 'Bulk updates apply atomically per SKU and report per-SKU outcome'),
	r('ADM-005', 'ADM', 'MUST', 'DATA', 'A stock write updates product inStock aggregate and facet counts', { measured: true }),

	// §6 Pages
	r('PAGE-001', 'PAGE', 'MUST', 'APP', 'Home, listing, detail and search render server-side in the initial HTML', { measured: true }),
	r('PAGE-002', 'PAGE', 'MUST', 'APP', 'Facets, sort and pagination are real links/forms with distinct URLs'),
	r('PAGE-003', 'PAGE', 'MUST', 'APP', 'Detail renders the variant matrix with per-variant availability'),
	r('PAGE-004', 'PAGE', 'MUST', 'APP', 'Every page emits Server-Timing'),
	r('PAGE-005', 'PAGE', 'SHOULD', 'APP', 'Markup comes from the shared component library'),
	r('PAGE-006', 'PAGE', 'MUST', 'APP', 'Navigation, faceting and pagination work without client-side JavaScript'),

	// §7 Identity
	r('AUTH-001', 'AUTH', 'MUST', 'APP', 'Shopper passwords use a real memory-hard or iterated KDF'),
	r('AUTH-002', 'AUTH', 'MUST', 'APP', 'KDF algorithm and parameters are identical across implementations'),
	r('AUTH-003', 'AUTH', 'MUST', 'APP', 'Sessions are established out of band; login is not in a measured path'),
	r('AUTH-004', 'AUTH', 'MUST', 'APP', 'Every authenticated request validates its session or token', { measured: true }),
	r('AUTH-005', 'AUTH', 'MUST', 'DATA', 'Operator authorization is server-side and not bypassable by a shopper'),
	r('AUTH-006', 'AUTH', 'MUST', 'APP', 'All accounts are seeded and driveable with no human or third-party step'),
	r('AUTH-007', 'AUTH', 'SHOULD', 'APP', 'Federated login may be offered; excluded from measured paths'),

	// §8 Corpora
	r('SEED-001', 'SEED', 'MUST', 'DATA', 'Catalog data is deterministic: same tier and seed, identical corpus'),
	r('SEED-002', 'SEED', 'MUST', 'DATA', 'Three tiers: sm, md, lg'),
	r('SEED-003', 'SEED', 'MUST', 'DATA', "The lg tier's working set exceeds the compared tier's memory"),
	r('SEED-004', 'SEED', 'MUST', 'DATA', 'Category tree, axes and vocabularies are fixed, not sampled per run'),
	r('SEED-005', 'SEED', 'MUST', 'DATA', 'Seeding is reproducible from a documented command and checksum-verifiable'),
	r('SEED-006', 'SEED', 'MUST', 'DATA', 'Media are deterministic placeholders served from the implementation origin'),

	// §9.3 Observability
	r('OBS-001', 'OBS', 'MUST', 'DATA', 'Responses carry Server-Timing decomposing data access, render and total'),
	r('OBS-002', 'OBS', 'MUST', 'DATA', 'Instrumentation exists from the first commit of a surface'),
	r('OBS-003', 'OBS', 'MUST', 'DATA', 'Responses indicate cache status, with the mechanism documented'),

	// §9.4 Personalization
	r('PERS-001', 'PERS', 'MUST', 'APP', 'A shopper resolves to exactly one segment from a fixed seeded set'),
	r('PERS-002', 'PERS', 'MUST', 'APP', 'Segment-keyed copy on home/listing and recommendations on detail', { measured: true }),
	r('PERS-003', 'PERS', 'MUST', 'APP', 'The generator is stubbed with fixed latency in every measured run'),
	r('PERS-004', 'PERS', 'MUST', 'APP', 'Segment is part of the cache key space wherever responses are cached', { measured: true }),

	// §9.5 Cart and checkout
	r('CART-001', 'CART', 'MUST', 'APP', 'Add to cart, change quantities, check out'),
	r('CART-002', 'CART', 'MUST', 'APP', 'Checkout uses a stubbed payment authorizer with fixed latency'),
	r('CART-003', 'CART', 'MUST', 'APP', 'Checkout decrements stock and produces a visible order'),
	r('CART-004', 'CART', 'MUST', 'APP', 'Insufficient stock fails cleanly with no partial order or stock change'),

	// §9.6 Realtime
	r('RT-001', 'RT', 'MUST', 'APP', 'An open detail page receives per-SKU stock changes without a reload'),
	r('RT-002', 'RT', 'SHOULD', 'APP', 'Transport is whatever the platform recommends; behaviour is the requirement'),
] as const;

const BY_ID = new Map(REQUIREMENTS.map((req) => [req.id, req]));

export function requirement(id: string): Requirement {
	const found = BY_ID.get(id);
	if (!found) throw new Error(`Unknown requirement id: ${id}`);
	return found;
}

export function requirementsFor(profile: Profile): Requirement[] {
	// APP is a superset of DATA — SPEC.md §2.
	return REQUIREMENTS.filter(
		(req) => !req.withdrawn && (req.profile === profile || (profile === 'APP' && req.profile === 'DATA'))
	);
}

/**
 * Every MUST must be covered by at least one test. Returns the uncovered ids, which is what
 * a CI check asserts is empty.
 */
export function coverageGaps(coveredIds: Iterable<string>, profile: Profile): string[] {
	const covered = new Set(coveredIds);
	return requirementsFor(profile)
		.filter((req) => req.level === 'MUST' && !covered.has(req.id))
		.map((req) => req.id);
}
