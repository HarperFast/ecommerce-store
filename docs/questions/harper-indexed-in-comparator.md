# Harper issue draft: `in` on an indexed attribute walks the whole index

**Status:** draft, unsent. For `HarperFast/harper`, suggested areas `search` and `performance`. The reference no longer depends on it; see [promotion candidates on `bench`](../plan.md#promotion-candidates-on-bench-2026-10-16).

## Summary

In Harper 5.3.2, a search condition `{ attribute, comparator: 'in', value: [...] }` on an `@indexed` attribute reads every entry of that attribute's index, however few values it names or rows it matches. Under async iteration (`for await`, and REST responses), each entry also costs one `setImmediate` turn. An `in` condition therefore costs about what a full table scan does, while the planner ranks it as selective as its matches.

The same predicate written as an OR of `equals` conditions reads only the matching index ranges and was 2.7 to 3 times faster in our measurements.

## Where it happens

At `v5.3.2` (`8e51444d1`), and unchanged on `main` at `5ed056a6a`:

- `searchByIndex`, `resources/search.ts:1032`: the `in` case sets `start = true; needFullScan = true`, with the comment "Phase 1: route through filter — index-merge optimization is a Phase 2 follow-up" (from [#460](https://github.com/HarperFast/harper/pull/460)).
- `resources/search.ts:1276`: with an index and a filter, `index.getRange({ start: true, ... })` tests every index entry and, unless the iteration is synchronous, wraps each one in `new Promise((resolve) => setImmediate(...))`.
- `estimateCondition`, `resources/search.ts:2065`: `in` is estimated as the sum of `getValuesCount` over its values, so the planner ranks it by what it matches rather than by the walk it performs, and may pick it to drive an AND.

A secondary effect: when the second condition of an AND is an `or` group, `mapConditionsToFilters` (`resources/search.ts:179`) wraps its filters in a closure without an `idFilter`. The reactive switch to an id set therefore cannot apply, and every row the lead condition matches is loaded.

## Reproduction

Use a 5,000-row table with two indexed `[String]` attributes, each row holding one value per attribute: four tiers and 13 categories, each plus a `*` wildcard.

```graphql
type Promotion @table {
	id: ID @primaryKey
	tierKeys: [String] @indexed
	categoryKeys: [String] @indexed
}
```

```js
// on the reference's `bench` promotions: 2,164 rows match the tier, 1,460 the categories, 619 both
Promotion.search({ conditions: [
	{ attribute: 'tierKeys', comparator: 'in', value: ['gold', '*'] },
	{ attribute: 'categoryKeys', comparator: 'in', value: ['apparel', 'electronics', 'home-kitchen', '*'] },
] });
```

Timings are in-process, Harper 5.3.2 on Linux (aarch64, a 2 CPU container), one worker, over 400 realistic probe values, three passes:

| Formulation | p50 | CPU per search |
|---|---|---|
| One `in` (tier, 2,195 rows on average) | 11.2 ms | 11.9 ms |
| The same as an OR of `equals` | 4.1 ms | 4.4 ms |
| Two `in` conditions, ANDed (647 rows) | 13.6 ms | 14.5 ms |
| The same as two ORs of `equals`, ANDed | 4.6 ms | 5.4 ms |
| Every row, filtered in JavaScript | 17.4 ms | 18.2 ms |

Run natively on macOS, the single two-condition `in` search took 72 ms at p50 for 19 ms of CPU. The difference is event-loop turns.

## Expected

For a non-negated `in` on a usable index, read one bounded range per distinct value, as an OR of `equals` already does, deduplicating primary keys when the attribute is multi-valued. That makes `in` cost what it matches, and makes its existing estimate true. Ideally an `in` or `or` group used as an AND filter should also be able to supply an id set.

## Workaround

Expand `in` into `{ operator: 'or', conditions: values.map((value) => ({ attribute, value })) }`. For an AND across two attributes, index the pairs together instead. The [reference application](../data-model.md#promotion-eligibility-index) now does this with a computed, indexed attribute.
