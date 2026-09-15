/**
 * Listing — SPEC.md §5.2.
 *
 * P0 skeleton: titles bind to requirement ids and the shapes are stated, but assertions are
 * fixme until P1 puts data behind them. The point of landing this now is that the coverage
 * check is real from the first commit.
 */
import { test, expect } from '@playwright/test';
import { API, listingSearchParams } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

test.describe('listing', () => {
	test.fixme(
		covers('PLP-001')('category selects the named category and all descendants'),
		async ({ request }) => {
			const parent = await request.get(`${API.products}?${listingSearchParams({ category: 'apparel' })}`);
			const child = await request.get(`${API.products}?${listingSearchParams({ category: 'apparel-shirts' })}`);
			expect((await parent.json()).total).toBeGreaterThan((await child.json()).total);
		}
	);

	test.fixme(covers('PLP-002')('total is exact, not capped'), async () => {});

	test.fixme(
		covers('PLP-003')('facet counts cover the full filtered set, not the page'),
		async ({ request }) => {
			const params = listingSearchParams({ category: 'apparel', pageSize: 1 });
			const body = await (await request.get(`${API.products}?${params}`)).json();
			const facetTotal = body.facets
				.find((f: { name: string }) => f.name === 'color')
				?.values.reduce((sum: number, v: { count: number }) => sum + v.count, 0);
			expect(facetTotal).toBeGreaterThan(body.items.length);
		}
	);

	test.fixme(covers('PLP-004')('facet values OR within a facet, AND across facets'), async () => {});

	// The requirement most likely to be broken by a future faceting optimisation, so it is
	// covered independently of the happy path — see docs/data-model.md.
	test.fixme(covers('PLP-005')("a facet's own counts exclude its own selections"), async () => {});

	test.fixme(covers('PLP-006')('inStock filtering and counts reflect live variant stock'), async () => {});
	test.fixme(covers('PLP-007')('price_asc and price_desc sort on priceMin and priceMax'), async () => {});
	test.fixme(covers('PLP-008')('a page beyond the last returns 200 with empty items'), async () => {});
	test.fixme(covers('PLP-009')('facets offered: color, size, brand, material, inStock'), async () => {});
});

test.describe('api conventions', () => {
	test.fixme(covers('API-001')('unknown query parameters are ignored'), async () => {});
	test.fixme(covers('API-002')('malformed parameters return 400 with the error envelope'), async () => {});
	test.fixme(covers('API-003')('missing resources return 404 with the error envelope'), async () => {});
	test.fixme(covers('API-004')('listing order is stable across identical requests'), async () => {});
	test.fixme(covers('API-005')('pageSize above the maximum is clamped, not errored'), async () => {});
	test.fixme(covers('API-006')('ETag and If-None-Match yield 304'), async () => {});
});

test.describe('catalog invariants', () => {
	test.fixme(covers('CAT-001')('variant options cover exactly the declared axes'), async () => {});
	test.fixme(covers('CAT-002')('sku and product slug are globally unique'), async () => {});
	test.fixme(covers('CAT-003')('summary aggregates match current variants'), async () => {});
	test.fixme(covers('CAT-004')('prices are integer minor units end to end'), async () => {});
	test.fixme(covers('CAT-005')('every product has at least one variant'), async () => {});
	test.fixme(covers('CAT-006')('a product belongs to at most one category per root subtree'), async () => {});
});
