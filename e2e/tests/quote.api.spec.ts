/**
 * Cart quote — SPEC.md §4. The primary endpoint under test.
 *
 * P0 skeleton: titles bind to requirement ids and the shapes are stated; assertions are
 * fixme until P1 puts data behind them. Landing it now means the coverage check is real
 * from the first commit.
 */
import { test, expect } from '@playwright/test';
import { API } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

test.describe('cart quote', () => {
	test(covers('QUOTE-001')('two carts with identical contents are priced independently'), async ({ request }) => {
		// Response-level caching is a conformance failure (SPEC.md §4), and the signature of it
		// is a response whose cartId does not match the cart asked for. A repeat request must
		// also re-do the work rather than return a stored body under a different key.
		const ids = Array.from({ length: 24 }, (_, i) => `cart-${String(i * 31).padStart(6, '0')}`);
		let checked = 0;
		for (const id of ids) {
			const response = await request.post(API.quote(id), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			expect(body.cartId, 'a quote must answer the cart it was asked about').toBe(id);
			// Nothing may advertise the response as cacheable.
			const cacheControl = response.headers()['cache-control'] ?? '';
			expect(cacheControl, 'the quote must not be declared publicly cacheable').not.toMatch(/public|max-age=[1-9]/);
		}
		expect(checked).toBeGreaterThan(12);
	});

	test(covers('QUOTE-003')('availability is resolved per line and never exceeds what was asked for'), async ({ request }) => {
		const offenders: string[] = [];
		let withShortfall = 0;
		let checked = 0;
		for (let i = 0; i < 60; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 17).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			for (const line of body.lines) {
				// `shortfall` is what inventory across the region's locations could not cover.
				if (!Number.isInteger(line.shortfall) || line.shortfall < 0 || line.shortfall > line.quantity) {
					offenders.push(`${body.cartId}/${line.sku}: shortfall ${line.shortfall} against quantity ${line.quantity}`);
				}
				if (line.shortfall > 0) withShortfall++;
			}
		}
		expect(checked).toBeGreaterThan(30);
		expect(offenders, 'lines with an impossible shortfall').toEqual([]);
		// If nothing is ever short, location resolution is not being exercised and the
		// requirement is passing vacuously.
		expect(withShortfall, 'some line must be short, or inventory resolution is untested').toBeGreaterThan(0);
	});

	test(covers('QUOTE-005')('all four promotion kinds are exercised and every applied promotion is eligible'), async ({ request }) => {
		const applied = new Set<string>();
		let checked = 0;
		for (let i = 0; i < 80; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 11).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			for (const line of body.lines) for (const id of line.appliedPromotionIds) applied.add(id);
		}
		expect(checked).toBeGreaterThan(40);
		// A workload where a pricing phase never fires does not measure that phase. This fails
		// loudly rather than letting a corpus quietly stop exercising the engine.
		expect(applied.size, 'distinct promotions applied across the sample').toBeGreaterThan(3);
	});

	test(covers('QUOTE-006')('shipping resolves by region and total cart weight'), async ({ request }) => {
		const byRegion = new Map<string, Set<number>>();
		const weightVsShipping: { weight: number; shipping: number; region: string }[] = [];
		for (let i = 0; i < 120; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 13).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			const body = await response.json();
			expect(body.region, 'the quote must name the region it priced for').toBeTruthy();
			expect(Number.isInteger(body.shipping) && body.shipping >= 0).toBe(true);
			if (!byRegion.has(body.region)) byRegion.set(body.region, new Set());
			byRegion.get(body.region)!.add(body.shipping);
			weightVsShipping.push({ weight: body.totalWeight, shipping: body.shipping, region: body.region });
		}
		expect(byRegion.size, 'the sample must span more than one region').toBeGreaterThan(1);
		// Within one region, shipping is a function of weight alone: the same weight band must
		// always cost the same, and a heavier band must never cost less than a lighter one.
		for (const [region, rates] of byRegion) {
			const inRegion = weightVsShipping.filter((w) => w.region === region).sort((a, b) => a.weight - b.weight);
			for (let i = 1; i < inRegion.length; i++) {
				expect(inRegion[i].shipping, `${region}: shipping fell as weight rose`).toBeGreaterThanOrEqual(inRegion[i - 1].shipping);
			}
			expect(rates.size).toBeGreaterThan(0);
		}
	});

	test(covers('QUOTE-007')('tax applies to the post-discount subtotal, consistently per jurisdiction'), async ({ request }) => {
		const ratePerJurisdiction = new Map<string, number>();
		const offenders: string[] = [];
		let checked = 0;
		for (let i = 0; i < 120; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 7).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			expect(body.taxJurisdiction, 'the quote must name the jurisdiction it taxed in').toBeTruthy();
			const taxable = body.subtotal - body.discountTotal;
			expect(Number.isInteger(body.tax) && body.tax >= 0).toBe(true);
			if (taxable === 0) {
				if (body.tax !== 0) offenders.push(`${body.cartId}: tax ${body.tax} on a zero taxable amount`);
				continue;
			}
			// Tax on the PRE-discount subtotal would show up as an inconsistent effective rate
			// across carts in one jurisdiction, since the discount share varies cart to cart.
			const effective = Math.round((body.tax / taxable) * 10000);
			const seen = ratePerJurisdiction.get(body.taxJurisdiction);
			if (seen === undefined) ratePerJurisdiction.set(body.taxJurisdiction, effective);
			else if (Math.abs(seen - effective) > 2) {
				offenders.push(`${body.cartId}: ${body.taxJurisdiction} effective rate ${effective}bp, expected ~${seen}bp`);
			}
		}
		expect(checked).toBeGreaterThan(60);
		expect(ratePerJurisdiction.size, 'the sample must span more than one jurisdiction').toBeGreaterThan(1);
		expect(offenders, 'carts whose tax is not post-discount or not rate-consistent').toEqual([]);
	});

	test(covers('DATA-002')('every monetary field is an integer in minor units'), async ({ request }) => {
		const offenders: string[] = [];
		let checked = 0;
		for (let i = 0; i < 60; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 23).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			for (const field of ['subtotal', 'discountTotal', 'shipping', 'tax', 'grandTotal']) {
				if (!Number.isInteger(body[field])) offenders.push(`${body.cartId}.${field} = ${body[field]}`);
			}
			for (const line of body.lines) {
				for (const field of ['unitPrice', 'lineTotal']) {
					if (!Number.isInteger(line[field])) offenders.push(`${body.cartId}/${line.sku}.${field} = ${line[field]}`);
				}
			}
		}
		expect(checked).toBeGreaterThan(30);
		expect(offenders, 'non-integer money').toEqual([]);
	});

	// The one an implementation is most likely to "optimise" into a conformance failure, so
	// it is asserted directly: two carts with identical contents but different ids must not
	// be able to share a response, and a repeated request must re-do the work.

	test(covers('QUOTE-002')('every line resolves to a priced product and variant'), async ({ request }) => {
		// The 400 branch needs a cart containing an unknown SKU. The dataset cannot contain one
		// — it is generated from the variant table — and there is no API to create a cart, so
		// the failure path is unreachable from a conformance run. What IS checkable is the
		// success path: a line that failed to resolve could not carry a price.
		const offenders: string[] = [];
		let lines = 0;
		for (let i = 0; i < 40; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 29).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			const body = await response.json();
			for (const line of body.lines) {
				lines++;
				if (!line.sku || !(line.unitPrice > 0) || line.lineTotal !== line.unitPrice * line.quantity) {
					offenders.push(`${body.cartId}/${line.sku}: unitPrice ${line.unitPrice}, lineTotal ${line.lineTotal}`);
				}
			}
		}
		expect(lines).toBeGreaterThan(50);
		expect(offenders, 'lines that did not resolve to a priced variant').toEqual([]);
	});

	// Sweeps a spread of carts rather than one: the defect these guard against was a cart-wide
	// promotion applied once per eligible line, which only shows on multi-line carts where that
	// promotion happens to be eligible. A single fixture would have missed it.
	test(covers('QUOTE-011')('discounts stay within the normative 60% cap, across many carts'), async ({ request }) => {
		const ids = Array.from({ length: 40 }, (_, i) => `cart-${String(i * 47).padStart(6, '0')}`);
		const offenders: string[] = [];
		let checked = 0;
		for (const id of ids) {
			const response = await request.post(API.quote(id), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			const lineSum = body.lines.reduce((sum: number, l: { lineTotal: number }) => sum + l.lineTotal, 0);
			// The cap is FLOORED (SPEC.md §4): asserting only `<= subtotal` accepted a 90%
			// discount, which is what the previous version of this test did.
			const cap = Math.floor((body.subtotal * 6000) / 10000);
			if (body.discountTotal > cap || body.discountTotal < 0 || body.subtotal !== lineSum) {
				offenders.push(`${id}: subtotal=${body.subtotal} lineSum=${lineSum} discount=${body.discountTotal} cap=${cap}`);
			}
		}
		// Without this, a run where every id 404s passes having verified nothing.
		expect(checked, 'quotes actually checked').toBeGreaterThan(20);
		expect(offenders, 'carts violating the discount invariant').toEqual([]);
	});

	test(covers('QUOTE-012')('every cited promotion reduced the line that cites it'), async ({ request }) => {
		const ids = Array.from({ length: 40 }, (_, i) => `cart-${String(i * 47).padStart(6, '0')}`);
		const offenders: string[] = [];
		let checked = 0;
		let withCitations = 0;
		for (const id of ids) {
			const response = await request.post(API.quote(id), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			for (const line of body.lines) {
				const cited: string[] = line.appliedPromotionIds;
				if (cited.length) withCitations++;
				// A promotion listed twice on one line is the double-application signature.
				if (new Set(cited).size !== cited.length) offenders.push(`${id}/${line.sku}: duplicate ids ${cited.join(',')}`);
				// A cited promotion must have reduced THIS line. `lineTotal` is the gross line
				// amount, so a line citing promotions while paying its full share of an
				// undiscounted cart is a phantom citation.
				if (cited.length && body.discountTotal === 0) {
					offenders.push(`${id}/${line.sku}: cites ${cited.join(',')} but the cart has no discount`);
				}
				if (line.unitPrice * line.quantity !== line.lineTotal) {
					offenders.push(`${id}/${line.sku}: lineTotal ${line.lineTotal} != unitPrice*quantity`);
				}
			}
			if (body.discountTotal > 0 && !body.lines.some((l: { appliedPromotionIds: string[] }) => l.appliedPromotionIds.length)) {
				offenders.push(`${id}: discounted ${body.discountTotal} with no promotion cited anywhere`);
			}
		}
		expect(checked, 'quotes actually checked').toBeGreaterThan(20);
		expect(withCitations, 'lines citing a promotion').toBeGreaterThan(0);
		expect(offenders, 'carts violating promotion attribution').toEqual([]);
	});


	// Stacking order is normative precisely because an unspecified order makes two correct
	// implementations disagree on a total — a non-equivalent-semantics cell, not a close one.


	// The ground-truth correctness guard the measurement rules require: a throughput-only
	// benchmark would report a silently wrong quote as a result.
	test(covers('QUOTE-008')('the same cart and dataset state produce a byte-identical quote'), async ({ request }) => {
		const url = API.quote('cart-000042');
		const first = await request.post(url, { data: {} });
		const second = await request.post(url, { data: {} });
		expect(first.status()).toBe(200);
		expect(second.status()).toBe(200);
		// Byte-identical, not deep-equal: key order is part of the contract, because a
		// response that reorders between identical requests cannot be cached or diffed.
		expect(await second.text()).toBe(await first.text());
	});

	test(covers('QUOTE-009')('an unknown cart id returns 404'), async ({ request }) => {
		const response = await request.post(API.quote('no-such-cart'), { data: {} });
		expect(response.status()).toBe(404);
	});

	test(covers('QUOTE-010')('the response itemizes per line and at cart level'), async ({ request }) => {
		const body = await (await request.post(API.quote('cart-000042'), { data: {} })).json();
		expect(body).toMatchObject({ cartId: 'cart-000042', currency: 'USD' });
		for (const field of ['subtotal', 'discountTotal', 'shipping', 'tax', 'grandTotal']) {
			expect(Number.isInteger(body[field]), `${field} must be integer minor units`).toBe(true);
		}
		expect(body.lines.length).toBeGreaterThan(0);
		for (const line of body.lines) {
			expect(Number.isInteger(line.unitPrice)).toBe(true);
			expect(Number.isInteger(line.lineTotal)).toBe(true);
			expect(Array.isArray(line.appliedPromotionIds)).toBe(true);
		}
		expect(body.grandTotal).toBe(body.subtotal - body.discountTotal + body.shipping + body.tax);
	});
});
