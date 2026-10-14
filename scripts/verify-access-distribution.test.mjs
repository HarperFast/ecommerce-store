/**
 * The access distribution's claims, checked by counting draws — packages/spec/src/workload.ts.
 *
 * The dataset generator and the load harness both draw from this distribution, and the
 * methodology requires its head claim to be checkable rather than asserted. These tests draw
 * the way the harness does and count.
 *
 *   node --test scripts/verify-access-distribution.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_SKEW, scramble, zipfIndex, zipfMass, zipfRank } from '@ecommerce-store/spec';

/** mulberry32, as the harness's streams use. */
function stream(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CATALOG = ACCESS_SKEW.catalogSize;
const HEAD = Math.floor(CATALOG * ACCESS_SKEW.headShare);

test('the exponent solves the head claim at the bench catalog size', () => {
	const head = zipfMass(CATALOG, HEAD);
	assert.ok(Math.abs(head - ACCESS_SKEW.headMass) < 0.001, `the hottest 1% take ${head}`);
	const top = zipfMass(CATALOG, 1);
	assert.ok(top > 0.025 && top < 0.028, `the hottest key takes ${top}`);
});

test('counted draws agree with the stated head and top-key mass', () => {
	const next = stream(42);
	const draws = 1_000_000;
	let head = 0;
	let top = 0;
	for (let i = 0; i < draws; i++) {
		const rank = zipfRank(next(), CATALOG);
		if (rank < HEAD) head++;
		if (rank === 0) top++;
	}
	// Binomial standard error at a million draws is about 0.0005 for the head, 0.00016 for the top key.
	assert.ok(Math.abs(head / draws - zipfMass(CATALOG, HEAD)) < 0.003, `head ${head / draws}`);
	assert.ok(Math.abs(top / draws - zipfMass(CATALOG, 1)) < 0.001, `top ${top / draws}`);
});

test('the scramble is a bijection, so it moves heat without changing how much there is', () => {
	for (const n of [1, 2, 3, 7, 1000, 2000, 300_000, CATALOG]) {
		const seen = new Uint8Array(n);
		for (let rank = 0; rank < n; rank++) {
			const key = scramble(rank, n);
			assert.ok(key >= 0 && key < n, `scramble(${rank}, ${n}) = ${key}`);
			assert.equal(seen[key], 0, `scramble(_, ${n}) maps two ranks to ${key}`);
			seen[key] = 1;
		}
	}
});

test('the hot keys are spread across the key space, not the lowest ids', () => {
	const hottest = Array.from({ length: 100 }, (_, rank) => scramble(rank, CATALOG));
	const inLowestTenth = hottest.filter((key) => key < CATALOG / 10).length;
	// A uniform spread puts about 10 of 100 in the lowest tenth; unscrambled, all 100 were.
	assert.ok(inLowestTenth < 25, `${inLowestTenth} of the 100 hottest keys are in the lowest tenth of ids`);
});

test('zipfIndex is the scrambled rank, so the generator and the harness name the same keys', () => {
	const next = stream(7);
	for (let i = 0; i < 1000; i++) {
		const u = next();
		assert.equal(zipfIndex(u, CATALOG), scramble(zipfRank(u, CATALOG), CATALOG));
	}
});
