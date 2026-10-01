Read `README.md` for what the application is, and `docs/plan.md` for the state of the work, what is blocked, and what may not yet be claimed. Keep `docs/plan.md` current — progress that lives only in commit messages is progress nobody can find.

The methodology in [`application-architecture-benchmarks`](https://github.com/HarperFast/application-architecture-benchmarks) is **binding, not background**. Its measurement rules and its rules about how results may be described govern anything done here.

Repo-specific:

- `npm run check` before proposing anything. A new MUST in `SPEC.md` without a test fails the coverage gate by design.
- `SPEC.md` is stack-neutral. If a requirement could not be satisfied by Fastify + Postgres + Redis, it is mis-specified.
- Read `docs/structure.md` before adding a dependency — a workspace's own `dependencies` ship to a deployed node even under `--omit=dev`.
- The dataset is a pinned contract. Regenerating it changes every number ever produced from it.
- Never claim a measurement the harness does not support; `bench/README.md` lists what it cannot.
