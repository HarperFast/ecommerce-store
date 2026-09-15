/** Pages, identity, personalization, cart and realtime — SPEC.md §6, §7, §9.4–§9.6. Profile: APP. */
import { test } from '@playwright/test';
import { covers, PROFILE } from '../lib/spec.ts';

test.skip(PROFILE !== 'APP', 'APP profile only — a DATA implementation renders no pages');

test.describe('pages', () => {
	test.fixme(covers('PAGE-001')('primary content is in the initial server-rendered HTML'), async () => {});
	test.fixme(covers('PAGE-002')('facets, sort and pagination are links with distinct URLs'), async () => {});
	test.fixme(covers('PAGE-003')('the variant matrix renders with per-variant availability'), async () => {});
	test.fixme(covers('PAGE-004')('every page emits Server-Timing'), async () => {});
	test.fixme(covers('PAGE-005')('markup comes from the shared component library'), async () => {});
	test.fixme(covers('PAGE-006')('navigation and faceting work with JavaScript disabled'), async () => {});
});

test.describe('identity', () => {
	test.fixme(covers('AUTH-001', 'AUTH-002')('passwords verify against the pinned KDF parameters'), async () => {});
	test.fixme(covers('AUTH-003')('sessions can be established out of band'), async () => {});
	test.fixme(covers('AUTH-004')('every authenticated request validates its session'), async () => {});
	test.fixme(covers('AUTH-006')('seeded accounts log in with no human or third-party step'), async () => {});
	test.fixme(covers('AUTH-007')('federated login, when offered, maps onto a shopper'), async () => {});
});

test.describe('personalization', () => {
	test.fixme(covers('PERS-001')('a shopper resolves to exactly one segment'), async () => {});
	test.fixme(covers('PERS-002')('segment-keyed copy and recommendations render'), async () => {});
	test.fixme(covers('PERS-003')('the generator is stubbed with fixed latency'), async () => {});
	// The failure here is a cache-key bug that leaks one shopper's segment to another, so it
	// is asserted directly rather than inferred from the copy rendering at all.
	test.fixme(covers('PERS-004')('one segment never receives another segment content'), async () => {});
});

test.describe('cart and checkout', () => {
	test.fixme(covers('CART-001')('add to cart, change quantities, check out'), async () => {});
	test.fixme(covers('CART-002')('checkout uses the stubbed payment authorizer'), async () => {});
	test.fixme(covers('CART-003')('checkout decrements stock and produces a visible order'), async () => {});
	test.fixme(covers('CART-004')('insufficient stock fails with no partial order or stock change'), async () => {});
});

test.describe('realtime', () => {
	test.fixme(covers('RT-001')('an open detail page receives stock changes without a reload'), async () => {});
});
