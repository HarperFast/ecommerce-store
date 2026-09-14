# Harper Ecommerce Store

The golden reference implementation of a Harper-native ecommerce catalog.

> **Status: P0 — spec freeze.** The scaffold and the structural decisions are in place.
> `SPEC.md` is not written yet, and there is no application code by design.

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
