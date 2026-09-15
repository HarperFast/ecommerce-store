# Harper Ecommerce Store

The golden reference implementation of a Harper-native ecommerce catalog.

> **Status: P0 — spec freeze, awaiting review.** [`SPEC.md`](SPEC.md) is written and
> self-review has passed; cross-model and human review are outstanding. There is no
> application code by design, and none is written until the gate passes.

## What this is

Two things at once, deliberately:

1. **A Harper reference.** A 100% Harper-native ecommerce catalog that a developer or
   customer can read to understand how Harper is meant to be used. It tracks the latest
   Harper release and is intended to eventually run as an E2E test for upcoming releases.
2. **The reference spec for platform comparisons.** The same *functionality* gets built on
   Vercel, Supabase, Netlify and others, and the implementations are benchmarked against
   each other.

Those two goals pull apart, and the resolution is the most important rule in this repo:

> **The spec is functional and platform-neutral. The implementation is maximally
> Harper-native.**

`SPEC.md` enumerates numbered requirements in terms of routes, behaviors and data
contracts — never mechanisms. Harper then satisfies each requirement the best Harper way,
and *that delta is the finding*.

Anything genuinely non-portable (MQTT, replication topology, `image-optimizer`) lives in a
flagged **harper-native tier**: exercised here, excluded from comparisons.

## Scope

Catalog page delivery at scale — which is what Harper ecommerce deployments actually are.

| Area | v1 |
|---|---|
| Catalog | ~50k products → 100k+ SKUs via option axes; tiered seed (sm/md/lg), `lg` exceeds free-node RAM |
| Surfaces | Home, PLP (category + facets + sort + pagination), Search, PDP (variant matrix + live per-SKU stock) |
| Search | Native Tantivy fulltext + facet counts |
| Personalization | Segment-keyed copy + recommendations; generator stubbed in all measured runs |
| Auth | Username/password + `@harperfast/oauth` as relying party. Real password hashing |
| Cart / checkout | Built; stubbed payment authorizer |
| Writes | Admin REST (**measured**) · cart/order (built, measured in v2) |
| Realtime | Per-SKU inventory push to open PDPs |
| Media | Deterministic generated placeholders; real media is a recorded expansion point |

## Reading order

| | |
|---|---|
| [`SPEC.md`](SPEC.md) | The specification. Numbered, platform-neutral requirements. Start here. |
| [`packages/spec`](packages/spec) | Its machine-readable half — route contract, types, requirement registry. |
| [`e2e/`](e2e) | Its executable half — every test names the requirements it covers. |
| [`docs/structure.md`](docs/structure.md) | Why the repo is laid out this way. Read before adding a dependency. |
| [`docs/data-model.md`](docs/data-model.md) | The variant model, and the aggregate-maintenance decision. |
| [`docs/seed-design.md`](docs/seed-design.md) | Deterministic corpora and why they are distributed, not re-derived. |
| [`docs/auth-design.md`](docs/auth-design.md) | Two principals, and the measured KDF parameter choice. |

## Checks

```bash
npm run check
```

Runs four things, each with a committed negative test: SPEC.md agrees with the requirement
registry; every applicable MUST has a test; the tree typechecks; and a simulated deploy
lands nothing dev-only on the node.

## Structure

The repo root is the Harper component root *and* the Next.js app root — this is a hard
deployment constraint, not a preference. Shared code lives in `packages/*` as plain npm
workspaces, with no vendoring and no bundle step.

**Read [`docs/structure.md`](docs/structure.md) before adding a dependency.** It documents
the one rule that is easy to get wrong: a workspace package's own `dependencies` ship to the
node even when the root lists that workspace under `devDependencies`.

## Versions

Pinned and verified 2026-09-14:

| | |
|---|---|
| harper | `5.2.12` |
| `@harperfast/nextjs` | `2.2.4` |
| next | `16.3.5` |
| react / react-dom | `19.3.0` |

## Development

```bash
npm install
```

```bash
npm run dev
```

## License

MIT
