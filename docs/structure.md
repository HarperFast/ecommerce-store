# Repository structure — decision record

Status: **decided** (P0). Verified against Harper `5.2.12` on 2026-09-14,
re-verified 2026-10-01.

## The question

This repo is an **Example** under the org repository taxonomy: it must be clonable and
deployable as-is, and it tracks the latest Harper release. But it also wants shared
packages — a platform-neutral spec, a seed generator, shared UI, and a portable e2e suite
that runs against competitor implementations too.

Those two pull against each other. `harper-vs-vercel-benchmark` resolved it with a
`vendor/shared` directory plus an esbuild bundle step. We wanted something less ugly.

## The constraint (why the app is at the repo root)

**The repo root is the Harper component root and the Next.js app root.** Not a preference —
a hard constraint, from two independent places:

1. **Harper does not implement npm's `#path:` git extension.** `deploy_component` with
   `package=github:owner/repo` resolves through `parseGitReference`
   (`components/Application.ts`), which returns `null` for a `#path:` committish. The caller
   treats that as "recognized as git, but not safely handleable" and **fails loudly** rather
   than falling back. So `package=github:HarperFast/ecommerce-store#path:apps/store` is not
   deployable. A single directory tree is the unit of deployment.
2. Harper framework plugins that wrap an application (`@harperfast/nextjs`, for example)
   likewise expect their config at the component root.

Consequence: `config.yaml`, `resources/` and `schemas/` live at the top level, and
`packages/*` are subdirectories of the deployed tree.

**Note on (2):** P0 has no web framework — it is two JSON endpoints, and Next.js, React and
a shared component package were removed rather than carried as inert dependencies that ship
~300 MB to every node. Constraint (1) is sufficient on its own, so reintroducing a
framework with the storefront reopens nothing here.

## The resolution: plain npm workspaces, no vendoring, no bundle step

Verified empirically against the exact commands Harper runs, not inferred:

| Step | What Harper runs | Result |
|---|---|---|
| Pack | `npm pack --json --ignore-scripts <clone>` | `packages/**` included intact; `node_modules`, `.next` excluded via `.gitignore` |
| Extract | tar to `components/<project>`, flattening one wrapper dir | workspace dirs are real directories |
| Install | `npm install --force --omit=dev --no-audit --no-fund` (cwd = component root) | `node_modules/@ecommerce-store/{spec,ui,seed}` → relative symlinks into `packages/`; 26 packages, no dev tooling |
| Runtime | `import { … } from '@ecommerce-store/spec'` | resolves |

The `e2e/` exclusion below was originally forced by a Next.js optional peer dependency.
Next.js is gone from P0, but the exclusion stays: it is correct on its own terms, and the
leak would silently return the moment a framework does.

`--install-links` is added only on win32 for candidate builds; on POSIX (Fabric) npm links
`file:`/workspace dependencies **relatively**, which survives the staging→live rename.

### The rule that matters

> `--omit=dev` at the root does **not** protect you from a workspace package's own
> `dependencies`. They are installed on the node regardless of how the root references that
> workspace.

Measured: a workspace listed in the root's `devDependencies`, carrying an external package
in its own `dependencies`, **was installed** under `--omit=dev`. Moving that package to the
workspace's `devDependencies` omitted it correctly.

So:

- `packages/spec` — runtime. Root `dependencies`. Keep its deps minimal.
- `packages/seed` — dev-only. Everything heavy goes in **that workspace's**
  `devDependencies`, never its `dependencies`.

A dev-only workspace is still symlinked onto the node — that is harmless (source files
only) and it is what lets the deployment double as an E2E target for Harper releases.

### Why `e2e/` is not a workspace

`@ecommerce-store/e2e` lives at the repo root, outside the `packages/*` glob, with its own
`package.json` and its own `node_modules`. It consumes the spec via
`"@ecommerce-store/spec": "file:../packages/spec"`.

That looks like an inconsistency. It is deliberate, and the reason is measured:

> **`next@16.3.5` declares `@playwright/test` as an _optional peer dependency_.** npm
> installs an optional peer once anything in the resolution tree makes it satisfiable. With
> Playwright declared in a workspace — even in that workspace's `devDependencies`, even
> under `--omit=dev` — npm satisfied next's optional peer and shipped **~18 MB**
> (`@playwright/test` + `playwright` + `playwright-core`) to the node.

Measured on the real scaffold: 30 packages with the e2e workspace, **26** without. Removing
only the Playwright declaration dropped it to 27, which isolates the cause to the
declaration rather than to anything else in the tree.

The structural argument points the same way. The e2e suite is the executable spec: it runs
against **any** implementation via `BASE_URL` — Harper, Vercel, Supabase — so it is not a
component of this application and should not be in its dependency graph.

`npm pack` still ships `e2e/**` as source (kilobytes), so a deployed node remains a
self-describing E2E target; its dependencies are simply never installed there.

**If you add a dev tool anywhere under `packages/*`, re-run the deploy simulation in
`scripts/verify-deploy.sh` and check the installed package count.** Optional peer dependencies
make this class of leak invisible in the manifest.

### Other install-path behavior worth knowing

- If `node_modules` already exists in the payload, **install is skipped entirely** and the
  runtime is treated as opaque for redeploy comparison. Never ship `node_modules`.
- **There is now a `.npmignore`, and it REPLACES `.gitignore` for packing — it does not
  merge with it.** Anything `.gitignore` excludes must be repeated there or it lands in the
  deployed component. It exists because the ~800 MB dataset is committed to git (it is the
  benchmark's contract) but must not ship in a deploy payload: it is loaded separately via
  the operations API, outside the measured run.
- `devEngines.packageManager` can select pnpm/yarn, which then run with **their own**
  install defaults (dev dependencies included). We stay on npm deliberately: the zero-config
  path is the one a customer will clone, and it is the one Harper exercises by default.
- A custom `install.command` makes the whole installation opaque to Harper. Avoided.

## Layout

```
ecommerce-store/            repo root = Harper component root = Next.js app root
  config.yaml               component config; plugin ORDER is load-bearing (see file)
  schemas/*.graphql         the eight tables, @export'd
  resources/*.js            the two endpoints
  packages/
    spec/                   route contract + requirement ids — stack-neutral, runtime
    seed/                   deterministic dataset generator — dev-only
  e2e/                      Playwright suite, the executable spec — NOT a workspace
  dataset/                  the committed, checksummed dataset
  docs/
  SPEC.md                   numbered, stack-neutral requirements
```

Measurement scaffolding does not live here at all. The harness — clock pinning, load ladder,
per-target CPU accounting, correctness guards — is shared across comparisons and lives in
the benchmarks repo. A customer reading this reference should see an ecommerce application,
not a benchmark rig.

## Open

- **`server-timing`.** Lands with the first endpoint, not after it (`OBS-003`). Its
  `config.yaml` ordering constraint is already recorded.
