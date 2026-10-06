# Repository structure — decision record

Status: **decided** (P0). Verified against Harper `5.2.12`.

## The question

This repo is an **Example** under the org repository taxonomy: it must be clonable and
deployable as-is, and it tracks the latest Harper release. But it also wants shared
packages — a platform-neutral spec, a seed generator, and a portable e2e suite that runs
against competitor implementations too.

Those two pull against each other. The alternative resolution is a `vendor/` directory plus
a bundle step, which works and costs a build stage plus a copy of every shared file. Plain
workspaces avoid both.

## The constraint (why the app is at the repo root)

**The repo root is the Harper component root.** Not a preference — a hard constraint, from
two independent places:

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

That looks like an inconsistency. Two reasons it is not.

**Optional peer dependencies defeat `--omit=dev`.** npm installs an optional peer as soon as
anything in the resolution tree makes it satisfiable. A package that declares
`@playwright/test` as an optional peer — web frameworks do — will therefore pull Playwright
onto a deployed node merely because some workspace in the tree declares it, even in that
workspace's `devDependencies`, even under `--omit=dev`. That is tens of megabytes of browser
tooling on a production node, and nothing in the manifest shows it coming.

Keeping Playwright out of the workspace graph entirely is the only form of this that does
not depend on which packages happen to be installed.

**The e2e suite is not part of this application.** It is the executable spec: it runs
against **any** implementation via `BASE_URL` — Harper, Vercel, Supabase — so it does not
belong in the dependency graph of one of them.

`npm pack` still ships `e2e/**` as source (kilobytes), so a deployed node remains a
self-describing E2E target; its dependencies are simply never installed there.

**If you add a dev tool anywhere under `packages/*`, re-run the deploy simulation in
`scripts/verify-deploy.sh` and check the installed package count.** Optional peer dependencies
make this class of leak invisible in the manifest.

### Other install-path behavior worth knowing

- If `node_modules` already exists in the payload, **install is skipped entirely** and the
  runtime is treated as opaque for redeploy comparison. Never ship `node_modules`.
- **`.npmignore` REPLACES `.gitignore` for packing — it does not merge with it.** Anything `.gitignore` excludes must be repeated there or it lands in the
  deployed component. It exists because the ~800 MB dataset is committed to git (it is the
  benchmark's contract) but must not ship in a deploy payload: it is loaded separately via
  the operations API, outside the measured run.
- `devEngines.packageManager` can select pnpm/yarn, which then run with **their own**
  install defaults (dev dependencies included). We stay on npm deliberately: the zero-config
  path is the one a customer will clone, and it is the one Harper exercises by default.
- A custom `install.command` makes the whole installation opaque to Harper. Avoided.

## Layout

```
ecommerce-store/            repo root = Harper component root
  config.yaml               component config; plugin ORDER is load-bearing (see file)
  schemas/store.graphql     the eight tables, @export'd, plus the derived ProductView cache
  resources/*.js            the two endpoints, the admin write surface, and their lib/
  packages/
    spec/                   route contract + requirement ids — stack-neutral, runtime
    seed/                   deterministic dataset generator — dev-only
  e2e/                      Playwright suite, the executable spec — NOT a workspace
  dataset/                  the committed, checksummed dataset
  scripts/                  dataset load/verify, deploy simulation, run-record validation
  bench/                    the load harness
  containers/               the containerized run topology and its orchestrator
  docs/
  SPEC.md                   numbered, stack-neutral requirements
```

### Why the harness lives here

`bench/` and `containers/` are measurement scaffolding, and scaffolding shared across
comparisons belongs in the benchmarks repo. It is here because there is one implementation,
so there is nothing yet to share it *with*, and a harness developed apart from the only
target it runs against is a harness nobody runs.

It moves to the benchmarks repo when a second target makes it genuinely shared — which is
the same point at which "containerized identically for every target" stops being vacuous.

Until then the separation is by directory, not by repo: nothing under `resources/` or
`packages/` imports from `bench/`, and `.npmignore` keeps both out of a deployed component.
A customer reading this reference should see an ecommerce application, not a benchmark rig.

## Open

- **`server-timing` is emitted inline, not by a plugin.** Both endpoints set the header
  directly, which satisfies `OBS-001`/`OBS-003` and needs no plugin ordering. The commented
  block in `config.yaml` records the ordering constraint for the day a plugin does the
  decomposition — earlier-registered http listeners are outer middleware layers, so it
  would have to be registered before any handler whose time it decomposes. Left commented
  rather than deleted because the constraint is the expensive part to rediscover.
