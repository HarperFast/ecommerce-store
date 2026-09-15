# Identity design

Status: **P0 decision, one input provisional.** Satisfies SPEC.md §7.

## Two principals, deliberately not one

| | Operator | Shopper |
|---|---|---|
| Population | tens | 100,000+ |
| Purpose | admin writes (§5.5) | storefront sessions, cart, orders |
| Enforcement | **Harper-native users + roles** | **application-level `Shopper` + sessions** |
| Cost profile | rare, latency-irrelevant | every request, latency-critical |

This is not a compromise between two options — it is the correct answer to two different
problems, and demonstrating the difference is itself valuable, because the distinction
between an *application* admin and Harper's `super_admin` (which administers the instance)
is one customers routinely get wrong.

**Operator → Harper-native.** Access control is enforced by the database rather than by
application code, and `rest: true` + `@export` + a role yields the entire authenticated
admin write surface with no handler code. On every competitor this is a hand-written set of
route handlers plus an auth check. **That asymmetry is a finding**, and it belongs in the
qualitative column of the comparison — not hidden as test scaffolding.

**Shopper → application-level.** 100k+ storefront accounts with application semantics,
session-backed, validated on every request. Harper's native user system is not shaped for
that population, and session validation cost is the architecturally interesting measurement
(`AUTH-004`).

### Boundary questions carried into P1

Named rather than silently resolved:

1. Where does a **customer-service operator** sit — someone who needs shopper-scoped read
   access? Native role with a scoped grant, or an application role on the `Shopper` side?
2. Do `Shopper` records get **DB-enforced** access control, or app-enforced?
3. What is the measured cost difference between validating a native session and an
   application session on the same request?

(3) is the one that matters most: it is the comparison axis against Supabase's stateless
JWT + RLS model, which is genuinely fast but has weak revocation. Answering it needs a
running instance, so it is P1 work, not P0 speculation.

## Password hashing

`AUTH-001` requires a real KDF; `AUTH-002` requires identical parameters across every
implementation, because otherwise the comparison measures whichever work factor each team
happened to pick.

### The trap

Node's `crypto.scrypt` defaults `maxmem` to 32 MiB and **throws** above it. Every parameter
set at or above 32 MiB per hash fails at the first real login unless `maxmem` is passed
explicitly — and it fails at runtime, not at startup.

### Measured

`scripts/measure-kdf.mjs`, Node v24.19.0, 12 CPUs, 512 MiB assumed hashing budget.
Memory per hash is `128 * N * r`.

| Parameters | Mem/hash | Default `maxmem` | Serial | p95 @8 | Max concurrent in 512 MiB |
|---|---|---|---|---|---|
| N=2¹⁷ r=8 p=1 | 128 MiB | **THROWS** | 234 ms | 556 ms | **4** |
| N=2¹⁶ r=8 p=2 | 64 MiB | **THROWS** | 213 ms | 490 ms | 8 |
| **N=2¹⁵ r=8 p=3** | **32 MiB** | **THROWS** | **160 ms** | **374 ms** | **16** |
| N=2¹⁴ r=8 p=5 | 16 MiB | ok | 126 ms | 298 ms | 32 |
| N=2¹³ r=8 p=10 | 8 MiB | ok | 131 ms | 302 ms | 64 |

The deciding column is the last one. scrypt is memory-hard by design, so **memory per hash,
not time per hash, is what caps a small node** — concurrent logins each hold their own
buffer simultaneously. At N=2¹⁷ a mere eight concurrent logins reserve 1 GiB, which is the
entire free-tier node.

### Decision

**scrypt, N=2¹⁵, r=8, p=3, 64-byte output, 16-byte random salt per user, `maxmem` passed
explicitly at `2 × 128 × N × r`.**

- Zero native dependencies. Fabric builds on deploy; a native compile step (argon2, bcrypt)
  is friction with no upside here.
- 32 MiB per hash leaves room for ~16 concurrent logins inside a 512 MiB budget, on a node
  that also has to serve a catalog.
- 160 ms is irrelevant to the benchmark: `AUTH-003` keeps login out of every measured path.
  Correctness is the goal, and we are explicitly willing to pay for it.
- The hasher sits behind an interface, so argon2id is a configuration change rather than a
  refactor.

### Provisional — two things to close

1. **Re-measure on the real tier.** These numbers are from a 12-core workstation with 18 GiB
   of RAM. The decision is a memory-pressure decision, and a workstation cannot show the
   pressure. Re-run on a 1 GB Fabric node before the spec freezes:

   ```bash
   KDF_BUDGET_MIB=384 node scripts/measure-kdf.mjs 16
   ```

   If p95 degrades non-linearly there, drop to N=2¹⁴ r=8 p=5 — which has the additional
   property of working without an explicit `maxmem`.

2. **Verify the parameter sets against the current OWASP Password Storage Cheat Sheet.**
   The table above is measurement, which is trustworthy; the claim that these are the
   *recommended* sets is recall, which is not. Confirm before freeze.

## Federated login

v1 ships username/password as the spine: it is the portable path every competitor
implements, it is trivially bot-operable (`AUTH-006`), and it puts session validation in the
measured path.

`@harperfast/oauth` v2.6.0 is added as a **relying party** — a `config.yaml` entry plus an
`onLogin` hook that maps a federated identity onto a `Shopper` record. Social login
alongside password is the realistic ecommerce pattern, and it puts a maintained first-party
plugin in the flagship reference. It is **excluded from measured paths** (`AUTH-007`):
the handshake leaves the platform and costs every implementation the same, and third-party
providers actively block automated browsers, so a measured OAuth path would require a
test-only bypass — meaning the path we ship would not be the path we test.

Whether Harper can go further and act as the **authorization server** for first-party
shoppers is an open question with the plugin's maintainers — see
[`docs/questions/oauth-authorization-server-scope.md`](questions/oauth-authorization-server-scope.md).
v1 does not depend on the answer.
