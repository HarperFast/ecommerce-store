# Repository structure

**Decision:** plain npm workspaces, with the Harper component at the repo root. Verified against Harper `5.2.12`.

## Deployment layout

The repo must be clonable and deployable as an application while also carrying a shared specification, seed generator, and portable conformance suite.

Harper deploys a single directory tree. Its `parseGitReference` implementation in `components/Application.ts` rejects npm's `#path:` git extension, so `github:HarperFast/ecommerce-store#path:apps/store` cannot deploy a nested application. Framework plugins such as `@harperfast/nextjs` also expect configuration at the component root, though P0 uses no web framework.

```text
ecommerce-store/            repo root = Harper component root
  config.yaml               component config and plugin ordering
  schemas/store.graphql     eight entities plus the ProductView cache
  resources/                endpoints, admin writes, shared application code
  packages/
    spec/                   stack-neutral contract and requirement registry; runtime
    seed/                   deterministic generator; development only
  e2e/                      portable Playwright suite; not a workspace
  dataset/                  committed, checksummed datasets
  scripts/                  loading, verification, and deploy simulation
  bench/                    HTTP load harness
  containers/               benchmark topology and orchestrator
  docs/
  SPEC.md                   numbered, stack-neutral requirements
```

Plain workspaces avoid a vendoring or bundling step. The verified deployment sequence is:

| Step | Command or behavior |
|---|---|
| Pack | `npm pack --json --ignore-scripts <clone>` includes the workspace directories. |
| Extract | Unpack into `components/<project>`, removing the archive's wrapper directory. |
| Install | `npm install --force --omit=dev --no-audit --no-fund` at the component root links the workspaces. |
| Run | Imports from `@ecommerce-store/spec` resolve through those links. |

On POSIX, workspace links are relative and survive the staging-to-live rename. Harper adds `--install-links` only for Windows candidate builds.

## Dependency rules

**A workspace's own `dependencies` are installed even under root `--omit=dev`, including when the root lists that workspace in `devDependencies`.** Put development tools in the owning workspace's `devDependencies`.

- `packages/spec` is a runtime dependency; keep it minimal.
- `packages/seed` is development-only; heavy dependencies belong in its `devDependencies`.
- Development-only workspaces may still be linked on a node as source files.

### Why `e2e/` is separate

Optional peer dependencies can pull development tooling into a production install. If a package declares Playwright as an optional peer, a workspace declaration can make it resolvable even under `--omit=dev`.

The conformance suite therefore stays outside the `packages/*` workspace graph, with its own manifest and installation. It references the specification through `file:../packages/spec` and runs against any implementation via `BASE_URL`.

**After adding a dependency, run `scripts/verify-deploy.sh`.** It reproduces Harper's pack/install sequence and checks that runtime dependencies resolve and forbidden development tools are absent. It also runs in `npm run check`.

## Packing and installation

- **Never ship `node_modules`.** If it is present in the payload, Harper skips installation and treats the runtime as opaque during redeploy comparison.
- **`.npmignore` replaces `.gitignore` for packing.** Repeat all required exclusions. The current file excludes datasets, the harness, containers, and `e2e/`; these are loaded or run separately.
- **Keep npm as the package manager.** Selecting pnpm or yarn through `devEngines.packageManager` changes install defaults, including development-dependency handling.
- A custom `install.command` makes installation opaque to Harper; the repo uses the default path.

## Harness location

`bench/` and `containers/` live beside the only implementation they currently exercise. Move shared measurement scaffolding to the benchmarks repo when a second target exists. Application code does not import the harness, and it is excluded from deployment.

## Instrumentation

Both endpoints set `Server-Timing` directly. The product endpoint still lacks the required compute phase; see [open work](plan.md#open).

The commented plugin block in `config.yaml` preserves an ordering constraint for a future timing plugin: earlier HTTP listeners are outer middleware, so the plugin must register before the handlers it measures.
