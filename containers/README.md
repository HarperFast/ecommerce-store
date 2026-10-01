# Containerized benchmark topology

Local, production-like. Not a PaaS, and not claiming to be.

```bash
SCALE=dev ./containers/run-benchmark.sh
```

```bash
SCALE=bench TRIALS=3 ./containers/run-benchmark.sh
```

## The resource budget

| Service | CPUs | Memory | Why |
|---|---|---|---|
| `harper` | 2 | 2 GiB | The target. A competing stack must fit its **entire** architecture — framework, database, cache — inside this same budget, summed across every process. An architecture spread over three containers pays for all three out of this one allowance. |
| `bench` | 2 | 1 GiB | The load generator. Deliberately **outside** the target's budget: a generator spending the budget the architecture is being measured on is quietly taking the thing under test away from itself. |

Harper's worker-thread count is pinned to the CPU budget rather than left at its default of 4, so the target is not oversubscribed against its own limit and the value appears in the run record instead of being inherited.

## Measurement choices, stated because they are choices

Containerization is not a neutral wrapper. Each of these changes the number, so each is fixed identically for every target and recorded with the run.

- **Bridge networking**, not host. Host networking is faster and would invalidate any comparison unless every target used it too. The mode is recorded.
- **Plain HTTP on both ports.** Outside dev mode Harper defaults to HTTPS, and TLS termination is a real per-request cost with nothing to do with the architecture under test.
- **A named volume on a real filesystem.** Never tmpfs — it distorts file I/O enough to invalidate storage comparisons.
- **Harper installed globally at a pinned version**, asserted at build time. It is the platform hosting the application, not a dependency of it, which is how a real deployment works.
- **The same `npm install --force --omit=dev` Harper itself runs on deploy.** A container that installs differently from the deploy path is testing something other than what ships.

## Run lifecycle

`run-benchmark.sh` walks the phases in order, because how a system is loaded determines what is resident when measurement starts:

1. **Seed** — expand and load the dataset. Not measured; bulk loading millions of records is a one-off, not application behaviour a customer experiences.
2. **Snapshot** — the loaded state is archived. Because the workload includes writes, state does not survive between trials, so every trial restores from here rather than measuring a catalog the previous trials already mutated.
3. **Cold start** — restart the target, measure time to first successful response.
4. **Warm-up** — a fixed workload, identical for every target. Not a per-target tuning budget.
5. **Measure** — the reported ladder.

Cold, warm and hot are three different numbers and all three land in the run record. Only reporting the hot number hides how long a system takes to become useful.

## A trap worth knowing

`docker compose up` does **not** rebuild. Application code is `COPY`ed at image build time, so a `down -v && up -d` cycle silently runs the previous build — and the symptom is a behaviour change that does not appear, which reads as "my fix did not work" rather than "my fix was not deployed". `run-benchmark.sh` always builds; a manual cycle must too:

```bash
docker compose -f containers/compose.yaml build harper
```

## Known gaps

- **CPU clock is not pinned.** No cycle-normalized efficiency figure (ops per CPU-gigacycle) may be derived from any run produced here.
- **Per-target CPU accounting is one number.** Harper is a single process, so the breakdown that matters in an assembled stack — framework vs database vs cache — has no analogue until there is one to compare against.
- **On macOS, Podman runs inside a VM.** Container CPU and memory limits are enforced against the VM's share, not the host's, and the VM boundary is in the network path. A result that matters should be produced on a Linux host where the limits mean what they say.
- **Credentials in `containers/.env`** are local test values for a container that only ever gets benchmarked. Harper's installer requires them to run non-interactively.
