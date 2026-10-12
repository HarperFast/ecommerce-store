/**
 * The load harness.
 *
 * Implements the measurement rules from the benchmarks README that apply to a single
 * standalone target. Specifically:
 *
 *   - OPEN load model. Requests are scheduled at a constant arrival rate and issued whether
 *     or not earlier ones have returned. A closed loop would let the target throttle the
 *     load offered to it, which hides exactly the saturation behaviour we are looking for.
 *   - LOAD LADDER. A single saturating rate produces no inflection point. The reportable
 *     result is "sustains N rps before p99 crosses T", which requires the ladder.
 *   - GENERATOR HEADROOM. The generator's own CPU and its dispatch lag are recorded with
 *     every step, and a step where it saturates is marked unreliable rather than reported.
 *   - PER-TARGET CPU. The target's cgroups are read at every step boundary, so efficiency can
 *     be reported per unit of work rather than only as wall-clock throughput.
 *   - RAW SAMPLES RETAINED. Every observation is written out so intervals can be applied
 *     later without re-running. The record is rewritten after every step, so a generator
 *     that dies keeps the steps it finished.
 *   - COLD / WARM / HOT are three different numbers and all three are worth reporting.
 *
 * NOT yet implemented, and therefore NOT claimed: CPU clock pinning and cycle-normalized
 * efficiency (ops per CPU-gigacycle). Without pinning, any efficiency figure from this
 * harness is wall-clock bound and must not be published. Each step carries its wall-clock
 * start and end so host-side cycle samples (tier 2) can be joined to it. See bench/README.md.
 *
 *   node bench/run.mjs --rates 50,100,200,400 --duration 20
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { makeRequestFactory, makeWriterFactory, sampleIds, writeKeys } from './workload.mjs';
import { accountStep, readAll, resolveCgroups } from './cgroups.mjs';

const execFileAsync = promisify(execFile);

/**
 * The commit that produced the run.
 *
 * "Record exact run conditions" is a measurement rule, and a result that cannot be tied to
 * the code that produced it cannot be reproduced or disputed. A dirty tree is recorded as
 * such rather than silently reported as the commit it is based on.
 */
async function codeVersion() {
	// The generator image has no git; the orchestrator reads it on the host and passes it in.
	if (process.env.CODE_COMMIT) return { commit: process.env.CODE_COMMIT, dirty: process.env.CODE_DIRTY === '1' };
	try {
		const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD']);
		const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain']);
		return { commit: sha.trim(), dirty: dirty.trim().length > 0 };
	} catch {
		return { commit: null, dirty: null };
	}
}
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = argOf('url', 'http://localhost:9926');
const SCALE = argOf('scale', 'dev');
// Scale-aware: `dev` is committed raw, `bench` is expanded by scripts/prepare-dataset.mjs.
const DATASET = argOf('dataset', SCALE === 'dev'
	? join(import.meta.dirname, '..', 'dataset', 'dev')
	: join(import.meta.dirname, '..', '.work', 'dataset', SCALE));
const RATES = argOf('rates', '25,50,100,200').split(',').map(Number);
const DURATION = Number(argOf('duration', '15'));
const WARMUP = Number(argOf('warmup', '10'));
const QUOTE_SHARE = Number(argOf('quote-share', '0.5'));
const WRITE_RATE = Number(argOf('write-rate', '20'));
const OUT = argOf('out', join(import.meta.dirname, 'results'));
/** Keys sampled per table for the read path; write keys are derived from the product sample. */
const SAMPLE_LIMIT = 20_000;
/**
 * Ceiling on concurrent in-flight READS.
 *
 * An open model offers arrivals regardless of completions, so once the target saturates the
 * in-flight set grows without bound and the GENERATOR dies first — a harness failure
 * masquerading as a target failure. Past this ceiling arrivals are SHED and counted. A step
 * with shed arrivals is beyond the target's capacity: that is a result, not an error, but
 * the achieved rate for such a step is a floor rather than a measurement.
 *
 * 750, not 4000. At 4000 the generator held four thousand concurrent responses from a
 * saturated target — product aggregates run to tens of kilobytes at bench scale — and died
 * of heap exhaustion at ~507 MB, which is Node's default cap inside a 1 GiB container.
 *
 * Writes are outside the ceiling: they are a fixed, low-rate stream that WRITE-004 requires
 * to be identical for every target, so they are neither shed nor deferred behind reads.
 */
const MAX_IN_FLIGHT = Number(argOf('max-in-flight', '750'));
/** A write still outstanding after this is a failure, not a write that never happened. */
const WRITE_TIMEOUT_MS = 30_000;
/** How long a step waits for its tail before abandoning it. */
const DRAIN_MS = 30_000;
/** A pause between steps, so one step's abandoned server-side work does not land in the next. */
const QUIESCE_MS = 2_000;
/**
 * Cold start, measured by the orchestrator (it owns the restart) and passed in, so the three
 * numbers the run lifecycle wants — cold, warm, hot — all land in one record. Only reporting
 * the hot number hides how long a system takes to become useful.
 */
const COLD_MS = argOf('cold-ms', null);
/**
 * The target's cgroups, as `name=containerId` or `name=/cgroup/path`, comma-separated.
 *
 * Target CPU used to come from `ps` inside the generator, which cannot see the target's
 * processes from its own container — and the image has no `ps`, so every container run
 * recorded `targetCpuSeconds: null`. Had `ps` existed, the `grep -i harper` would have matched
 * the generator's own command line (`--url http://harper:9926`) and reported ITS CPU as the
 * target's. Read from cgroups instead; see bench/cgroups.mjs.
 */
const TARGET_CGROUPS = (argOf('target-cgroups', process.env.TARGET_CGROUPS ?? '') || '').split(',').filter(Boolean);
/**
 * Run conditions the generator cannot see from inside its container — platform version,
 * image, budget, placement, tier, snapshot — recorded by the orchestrator and passed in.
 */
const ORCHESTRATOR_CONDITIONS = process.env.RUN_CONDITIONS ? JSON.parse(process.env.RUN_CONDITIONS) : null;
/** Dispatch lag beyond this means the open-loop schedule slipped: the generator, not the target. */
const DISPATCH_LAG_FLAG_MS = 5;
/**
 * A step whose in-window throughput falls below this share of the offered rate did not keep
 * up, whether or not its backlog grew far enough to shed.
 */
const SATURATION_SHARE = 0.95;
/**
 * Request headers. `identity` explicitly: fetch otherwise offers gzip and deflate, so a target
 * that compressed would pay CPU the others do not and be decoded here without trace.
 * Responses that come back encoded anyway are counted.
 */
const READ_HEADERS = { 'accept-encoding': 'identity' };
const WRITE_HEADERS = { 'accept-encoding': 'identity', 'content-type': 'application/json' };

// Nearest-rank. The Math.max guards q=0, which would otherwise index -1.
const quantile = (sorted, q) =>
	sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] : NaN;

/** The `cache` entry of a Server-Timing header: 1 hit, 0 miss, null absent. */
function cacheStatus(serverTiming) {
	const desc = serverTiming?.match(/(?:^|,)\s*cache\s*;(?:[^,]*;)?\s*desc\s*=\s*"?(\w+)"?/)?.[1];
	return desc === 'hit' ? 1 : desc === 'miss' ? 0 : null;
}

/**
 * Drive one step of the ladder at a constant arrival rate.
 *
 * Arrivals are scheduled against a fixed timeline rather than `setInterval`, so a slow
 * target cannot slow the offered rate — the defining property of an open model.
 */
async function step({ rate, seconds, nextRequest, nextWrite, writeRate, label }) {
	const samples = [];
	const inFlight = new Set();
	// Per-step, so abandoning a saturated step's tail cannot touch the next one.
	const abort = new AbortController();
	const startedAt = performance.now();
	const startedAtEpochMs = Date.now();
	const cpuBefore = process.cpuUsage();

	let issued = 0;
	let writesIssued = 0;
	let shed = 0;
	let writeFailures = 0;
	let invalidations = 0;
	let encodedResponses = 0;
	const totalRequests = Math.round(rate * seconds);
	const totalWrites = Math.round(writeRate * seconds);

	const issue = async (request) => {
		const t0 = performance.now();
		try {
			const response = await fetch(request.url, {
				signal: abort.signal,
				method: request.method,
				headers: request.method === 'POST' ? WRITE_HEADERS : READ_HEADERS,
				body: request.method === 'POST' ? '{}' : undefined,
			});
			// Stream the body to completion WITHOUT retaining it. Cancelling the stream
			// instead destroys the socket rather than returning it to the keep-alive pool, so
			// every request paid TCP setup and the run measured connection churn; it also
			// ended the sample at headers, counting a truncated response as a success and
			// understating latency for any slow body.
			const serverTiming = response.headers.get('server-timing') ?? null;
			if (response.headers.get('content-encoding')) encodedResponses++;
			let bytes = 0;
			if (response.body) {
				const reader = response.body.getReader();
				try {
					for (let chunk; !(chunk = await reader.read()).done; ) bytes += chunk.value.byteLength;
				} finally {
					reader.releaseLock();
				}
			}
			const doneAt = performance.now();
			samples.push({
				kind: request.kind,
				// The cache status is reduced to a flag here rather than retaining the whole
				// Server-Timing string per sample: at hundreds of thousands of samples the
				// strings are the largest thing the generator holds, and only the flag is read.
				cacheHit: cacheStatus(serverTiming),
				ms: doneAt - t0,
				// Service time excludes the wait between an arrival's SCHEDULED time and its
				// dispatch. Reporting only service time is coordinated omission in a harness
				// whose entire claim is that it is open, so the scheduled-to-complete figure is
				// carried alongside and is what the ladder reports.
				arrivalMs: doneAt - request.scheduledAt,
				// Completion time from the step's start, so throughput can be counted inside the
				// offer window rather than credited for work drained after it.
				doneMs: doneAt - startedAt,
				status: response.status,
				bytes,
			});
		} catch (error) {
			const doneAt = performance.now();
			samples.push({ kind: request.kind, ms: doneAt - t0, arrivalMs: doneAt - request.scheduledAt, doneMs: doneAt - startedAt, status: 0, error: String(error.message ?? error) });
		}
	};

	/**
	 * Pace arrivals against a fixed timeline WITHOUT creating one timer per request.
	 *
	 * The first version of this scheduled every arrival up front with setTimeout and died of
	 * memory exhaustion at 6400 rps — the generator failing before the target, which is the
	 * exact failure the measurement rules tell us to guard against. Instead we wake on a
	 * short tick and issue however many arrivals have come due, which keeps the arrival
	 * process open-model (a slow target cannot slow the offered rate) at constant cost.
	 */
	const TICK_MS = 2;
	const requestInterval = 1000 / rate;
	const writeInterval = writeRate > 0 ? 1000 / writeRate : Infinity;

	const postWrite = async (write) => {
		try {
			const response = await fetch(write.url, {
				method: 'POST',
				headers: WRITE_HEADERS,
				body: JSON.stringify(write.body),
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(WRITE_TIMEOUT_MS)]),
			});
			const result = await response.json();
			// Writes are not timed, but they must be COUNTED — a run whose writes all failed is
			// not the run it claims to be. A write that never completes counts as failed.
			if (!response.ok) writeFailures++;
			else invalidations += result.invalidated ?? 0;
		} catch {
			writeFailures++;
		}
	};

	const reads = new Set();
	const track = (promise, isRead) => {
		inFlight.add(promise);
		if (isRead) reads.add(promise);
		promise.finally(() => {
			inFlight.delete(promise);
			reads.delete(promise);
		});
	};

	const deadline = startedAt + seconds * 1000;
	while (performance.now() < deadline) {
		const elapsed = performance.now() - startedAt;
		// Arrival k is scheduled at k * interval, so k + 1 arrivals are due once that time has
		// passed. Counting floor(elapsed / interval) dispatched every arrival one full interval
		// after the time it is measured from — 40 ms of phantom latency on every request at
		// 25 rps, 5 ms at 200, shrinking as the rate rises, which read as a target that got
		// faster under load.
		const dueRequests = Math.min(totalRequests, Math.floor(elapsed / requestInterval) + 1);
		while (issued < dueRequests) {
			const request = nextRequest();
			if (reads.size >= MAX_IN_FLIGHT) {
				// A shed arrival still consumes its draw, so the key sequence stays identical for
				// every target however much each one sheds.
				shed++;
			} else {
				track(issue({ ...request, scheduledAt: startedAt + issued * requestInterval }), true);
			}
			issued++;
		}
		if (writeRate > 0) {
			const dueWrites = Math.min(totalWrites, Math.floor(elapsed / writeInterval) + 1);
			while (writesIssued < dueWrites) {
				track(postWrite(nextWrite()), false);
				writesIssued++;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, TICK_MS));
	}

	// The offer window is what throughput and generator load are measured against. Dividing
	// by offer + drain deflated the 2400 rps step to a reported 1385 rps and diluted
	// generator CPU by the same factor, which could let a saturated generator pass its own
	// headroom check.
	const offerMs = performance.now() - startedAt;
	const offerSeconds = offerMs / 1000;
	const offerEndEpochMs = Date.now();
	const cpu = process.cpuUsage(cpuBefore);
	const readsInFlightAtOfferEnd = reads.size;

	// Drain whatever is still outstanding. Requests that never land are abandoned here, and
	// counted — if they were allowed to run on, they would complete during the NEXT step and
	// be attributed to a rate they were never offered at.
	const drainDeadline = performance.now() + DRAIN_MS;
	while (inFlight.size > 0 && performance.now() < drainDeadline) {
		await Promise.race([...inFlight, new Promise((r) => setTimeout(r, 100))]);
	}
	const outstanding = reads.size;
	abort.abort();
	// Let the aborted requests record their samples before anything is counted, or the raw
	// samples and the summary disagree.
	await Promise.allSettled([...inFlight]);
	const drainEndEpochMs = Date.now();

	const generatorCpuSeconds = (cpu.user + cpu.system) / 1e6;
	const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
	const okInWindow = ok.filter((s) => s.doneMs <= offerMs).length;
	// Product responses only: the quote is never response-cacheable and always reports `miss`,
	// so pooling it capped the rate at 1 - quoteShare and made it depend on how a stack labels
	// an uncacheable response. WRITE-003 forbids freshness by disabling caching; a product hit
	// rate of zero is what that looks like.
	const productCache = ok.filter((s) => s.kind === 'product' && s.cacheHit !== null && s.cacheHit !== undefined);
	const hits = productCache.filter((s) => s.cacheHit === 1).length;
	// Reported latency is SCHEDULED-arrival to completion. Service time is kept too, and a
	// large gap between them means the generator queued, not that the target was slow.
	const latencies = ok.map((s) => s.arrivalMs ?? s.ms).sort((a, b) => a - b);
	const serviceLatencies = ok.map((s) => s.ms).sort((a, b) => a - b);
	// Scheduled arrival to dispatch, for every sample. The open model's claim is that requests
	// leave on schedule whatever the target does; a lag here is the generator falling behind.
	const dispatchLags = samples.map((s) => s.arrivalMs - s.ms).sort((a, b) => a - b);
	// Successful throughput, counted INSIDE the offer window. Counting completions drained
	// after it credited a target that fell behind with the rate it was offered: at capacity 150
	// against 200 offered, a backlog under the shed ceiling drained in time to report 200.
	const achievedRate = okInWindow / offerSeconds;

	return {
		label,
		offeredRate: rate,
		seconds,
		// Wall-clock boundaries, so samples taken outside the generator (cgroup CPU, perf
		// cycles on tier 2) can be joined to the step they belong to.
		startedAtEpochMs,
		offerEndEpochMs,
		drainEndEpochMs,
		// `issued` counts arrivals actually offered; shed arrivals are reported separately and
		// are NOT folded in, so the two always sum to what the schedule called for.
		issued: issued - shed,
		shed,
		writesIssued,
		writeFailures,
		// Invalidations the write surface reported for this step's writes — as each
		// implementation defines `invalidated`, which SPEC.md does not yet.
		invalidations,
		// Reads in flight when the offer window closed, and still outstanding when the drain
		// deadline expired. The second are absent from the latency distribution: the tail is
		// censored.
		readsInFlightAtOfferEnd,
		outstandingAtDeadline: outstanding,
		completed: samples.length,
		ok: ok.length,
		okInWindow,
		errors: samples.length - ok.length + shed,
		encodedResponses,
		offerSeconds,
		achievedRate,
		completionRate: samples.length / offerSeconds,
		p50: quantile(latencies, 0.5),
		p90: quantile(latencies, 0.9),
		p99: quantile(latencies, 0.99),
		max: latencies.at(-1) ?? NaN,
		cacheObserved: productCache.length,
		cacheHitRate: productCache.length ? hits / productCache.length : null,
		p50Service: quantile(serviceLatencies, 0.5),
		p99Service: quantile(serviceLatencies, 0.99),
		dispatchLagP50: quantile(dispatchLags, 0.5),
		dispatchLagP99: quantile(dispatchLags, 0.99),
		dispatchLagMax: dispatchLags.at(-1) ?? NaN,
		generatorCpuSeconds,
		// One core's worth of the generator's own budget, over the OFFER window (CPU read at
		// offer end). Past ~0.8 the generator is a plausible bottleneck and the step must not be
		// reported as a target measurement.
		generatorCpuLoad: generatorCpuSeconds / offerSeconds,
		// Beyond capacity: arrivals were shed, or the target completed too little inside the
		// window. Either way the achieved rate is a floor, not a measurement.
		saturated: shed > 0 || achievedRate < SATURATION_SHARE * rate,
		samples,
	};
}

// --- run ---------------------------------------------------------------------------------

const manifest = JSON.parse(await readFile(join(DATASET, 'MANIFEST.json'), 'utf8'));

console.log(`target ${BASE_URL} · dataset scale ${manifest.scale} seed ${manifest.seed}`);
console.log(`${cpus().length} cpus · ${(totalmem() / 1024 ** 3).toFixed(1)} GiB · ${platform()} ${release()}\n`);

// Sampled across each full table, so the reachable working set spans the whole catalog rather
// than its first 20,000 rows. Row counts come from the manifest. Write keys are derived from
// the product sample so writes land on what is read (WRITE-001).
const rows = manifest.files;
console.log('sampling workload keys across the full dataset…');
const [cartIds, productIds] = await Promise.all([
	sampleIds(DATASET, 'cart', 'id', SAMPLE_LIMIT, rows.cart?.rows),
	sampleIds(DATASET, 'product', 'id', SAMPLE_LIMIT, rows.product?.rows),
]);
const keys = await writeKeys(DATASET, productIds);

const REQUEST_SEED = 1;
const WRITE_SEED = 7;
const nextRequest = makeRequestFactory({ baseUrl: BASE_URL, cartIds, productIds, quoteShare: QUOTE_SHARE, seed: REQUEST_SEED });
const nextWrite = makeWriterFactory({ baseUrl: BASE_URL, keys, seed: WRITE_SEED });
const cgroups = await resolveCgroups(TARGET_CGROUPS);
for (const cgroup of cgroups) {
	console.log(`target cgroup ${cgroup.name}: ${cgroup.dir ?? `UNRESOLVED (${cgroup.ref}) — target CPU will be null`}`);
}
if (!cgroups.length) console.log('no target cgroups given — target CPU will be null');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(OUT, `run-${stamp}.json`);
await mkdir(OUT, { recursive: true });
const code = await codeVersion();
console.log(`run record: ${file}`);

/** Derived from what the orchestrator recorded, not hardcoded. Tier 1 is signal, never results. */
function caveats() {
	const tier = ORCHESTRATOR_CONDITIONS?.tier ?? null;
	const list = [];
	if (tier !== 2) {
		list.push(`Tier ${tier ?? 'unknown'}: CPU clock neither pinned nor measured — no cycle-normalized efficiency figure may be derived from this run.`);
	} else {
		list.push('Tier 2: clock bounded and measured on the host, not pinned. Cycle figures come from host samples joined on step epoch times, not from this record.');
	}
	if (manifest.scale !== 'bench') list.push(`Dataset "${manifest.scale}" fits in memory: not a benchmark result (DATA-004).`);
	if (!cgroups.length || cgroups.some((cgroup) => !cgroup.dir)) list.push('Target CPU was not accounted for every target cgroup; targetCpuSeconds is null.');
	list.push('Generator shares a host with the target; see generatorCpuLoad and dispatchLagP99 per step.');
	return list;
}

/**
 * Write the record — after every step, not only at the end, so a generator that dies keeps
 * what it measured. The first bench attempt lost every raw sample to a heap exhaustion in its
 * fourth step. `complete` says whether the ladder finished.
 */
async function writeRecord(warm, steps, complete) {
	await writeFile(
		file,
		JSON.stringify(
			{
				complete,
				// Exact run conditions, recorded with the result — not reconstructed later.
				conditions: {
					code,
					target: BASE_URL,
					dataset: { scale: manifest.scale, seed: manifest.seed, generatorVersion: manifest.generatorVersion, files: manifest.files },
					// The generator's own view: its container's CPUs and the guest kernel, not the
					// target's budget. The target's budget and placement are in `orchestrator`.
					generatorHost: {
						cpus: cpus().length, model: cpus()[0]?.model, totalmemGiB: +(totalmem() / 1024 ** 3).toFixed(1),
						platform: platform(), release: release(), node: process.versions.node, undici: process.versions.undici ?? null,
					},
					orchestrator: ORCHESTRATOR_CONDITIONS,
					harness: {
						rates: RATES, quoteShare: QUOTE_SHARE, writeRate: WRITE_RATE, durationSeconds: DURATION,
						warmupSeconds: WARMUP, warmupRate: RATES[0], maxInFlight: MAX_IN_FLIGHT,
						drainMs: DRAIN_MS, quiesceMs: QUIESCE_MS, writeTimeoutMs: WRITE_TIMEOUT_MS,
						arrivals: 'deterministic, evenly spaced, dispatched on a 2 ms tick',
						seeds: { requests: REQUEST_SEED, writes: WRITE_SEED },
						requestHeaders: READ_HEADERS,
						connections: 'fetch default dispatcher (undici keep-alive pool, connections opened on demand)',
						keySampling: 'stride across full tables',
						writeKeys: 'variants and inventory of the sampled products',
						reachableKeys: { carts: cartIds.length, products: productIds.length, writeSkus: keys.skus, writeInventory: keys.inventory },
						targetCgroups: cgroups,
						targetCpu: cgroups.length ? 'cgroup v2 cpu.stat usage_usec, offer start to drain end' : null,
						cacheHitRate: 'product responses only',
						saturation: `shed arrivals, or in-window throughput below ${SATURATION_SHARE} of offered`,
					},
					lifecycle: {
						coldStartMs: COLD_MS === null ? null : Number(COLD_MS),
						// The earliest-DISPATCHED warm-up request, not the first to complete.
						warmupFirstResponseMs: warm ? (warm.samples.reduce((first, s) => (!first || s.doneMs - s.ms < first.doneMs - first.ms ? s : first), null)?.ms ?? null) : null,
						warmup: warm ? { startedAtEpochMs: warm.startedAtEpochMs, drainEndEpochMs: warm.drainEndEpochMs, errors: warm.errors } : null,
					},
					caveats: caveats(),
				},
				steps,
			},
			null,
			2
		)
	);
}

// COLD is measured by the caller restarting the target; this harness reports the first
// observation of the warm-up step separately so the number is not silently lost.
console.log(`warm-up ${WARMUP}s at ${RATES[0]} rps (not reported as a result)`);
const warm = await step({ rate: RATES[0], seconds: WARMUP, nextRequest, nextWrite, writeRate: WRITE_RATE, label: 'warmup' });
console.log(`  ${warm.errors} errors\n`);
await new Promise((resolve) => setTimeout(resolve, QUIESCE_MS));

console.log('rate   offered  achieved   p50      p90      p99      max     errors  genCPU  tgtCPU  cacheHit  inval');
console.log('─'.repeat(108));

const steps = [];
for (const rate of RATES) {
	const cgroupsBefore = await readAll(cgroups);
	const result = await step({ rate, seconds: DURATION, nextRequest, nextWrite, writeRate: WRITE_RATE, label: `rate-${rate}` });
	const cgroupsAfter = await readAll(cgroups);
	// Over offer and drain together: the target's work for this step's arrivals ends at drain.
	Object.assign(result, accountStep(cgroups, cgroupsBefore, cgroupsAfter));
	result.targetCpuLoad = result.targetCpuSeconds === null ? null : result.targetCpuSeconds / ((result.drainEndEpochMs - result.startedAtEpochMs) / 1000);
	steps.push(result);
	await writeRecord(warm, steps, false);

	let flag = result.generatorCpuLoad > 0.8 ? '  ⚠ GENERATOR saturated — not a target measurement' : '';
	if (result.saturated) flag += `  ⚠ saturated (shed ${result.shed}, ${result.readsInFlightAtOfferEnd} in flight at window end)`;
	if (result.writeFailures > 0) flag += `  ⚠ ${result.writeFailures} write failures (coherence workload degraded)`;
	if (result.cacheHitRate === 0) flag += '  ⚠ product cache hit rate 0 (WRITE-003: freshness must not come from disabling caching)';
	if (result.outstandingAtDeadline > 0) flag += `  ⚠ ${result.outstandingAtDeadline} never completed (tail censored)`;
	if (result.dispatchLagP99 > DISPATCH_LAG_FLAG_MS) flag += `  ⚠ dispatch lag p99 ${result.dispatchLagP99.toFixed(1)}ms (generator behind schedule)`;
	if (result.encodedResponses > 0) flag += `  ⚠ ${result.encodedResponses} compressed responses`;
	console.log(
		`${String(rate).padStart(5)}  ${String(result.issued).padStart(7)}  ` +
			`${result.achievedRate.toFixed(1).padStart(8)}  ${result.p50.toFixed(1).padStart(7)}  ` +
			`${result.p90.toFixed(1).padStart(7)}  ${result.p99.toFixed(1).padStart(7)}  ` +
			`${result.max.toFixed(0).padStart(7)}  ${String(result.errors).padStart(6)}  ` +
			`${result.generatorCpuLoad.toFixed(2).padStart(6)}  ` +
			`${(result.targetCpuLoad === null ? 'n/a' : result.targetCpuLoad.toFixed(2)).padStart(6)}  ` +
			`${(result.cacheHitRate === null ? 'n/a' : `${(result.cacheHitRate * 100).toFixed(1)}%`).padStart(8)}  ` +
			`${String(result.invalidations).padStart(5)}${flag}`
	);
	await new Promise((resolve) => setTimeout(resolve, QUIESCE_MS));
}

await writeRecord(warm, steps, true);
console.log(`\nraw samples retained: ${file}`);
