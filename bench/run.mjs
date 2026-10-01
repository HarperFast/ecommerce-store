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
 *   - GENERATOR HEADROOM. The generator's own CPU is recorded with every step, and a step
 *     where it saturates is marked unreliable rather than reported.
 *   - PER-TARGET CPU. The target process's CPU time is sampled per step, so efficiency can
 *     be reported per unit of work rather than only as wall-clock throughput.
 *   - RAW SAMPLES RETAINED. Every observation is written out so intervals can be applied
 *     later without re-running.
 *   - COLD / WARM / HOT are three different numbers and all three are worth reporting.
 *
 * NOT yet implemented, and therefore NOT claimed: CPU clock pinning and cycle-normalized
 * efficiency (ops per CPU-gigacycle). Without pinning, any efficiency figure from this
 * harness is wall-clock bound and must not be published. See bench/README.md.
 *
 *   node bench/run.mjs --rates 50,100,200,400 --duration 20
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { makeRequestFactory, makeWriterFactory, sampleIds } from './workload.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = argOf('url', 'http://localhost:9926');
const OPS_URL = argOf('ops', 'http://localhost:9925');
const DATASET = argOf('dataset', join(import.meta.dirname, '..', 'dataset'));
const RATES = argOf('rates', '25,50,100,200').split(',').map(Number);
const DURATION = Number(argOf('duration', '15'));
const WARMUP = Number(argOf('warmup', '10'));
const QUOTE_SHARE = Number(argOf('quote-share', '0.5'));
const WRITE_RATE = Number(argOf('write-rate', '20'));
const OUT = argOf('out', join(import.meta.dirname, 'results'));
/**
 * Ceiling on concurrent in-flight requests.
 *
 * An open model offers arrivals regardless of completions, so once the target saturates the
 * in-flight set grows without bound and the GENERATOR dies first — which is a harness
 * failure masquerading as a target failure. Past this ceiling arrivals are SHED and counted.
 * A step with shed arrivals is beyond the target's capacity: that is a result, not an error,
 * but the achieved rate for such a step is a floor rather than a measurement.
 */
const MAX_IN_FLIGHT = Number(argOf('max-in-flight', '4000'));
/**
 * Cold start, measured by the orchestrator (it owns the restart) and passed in, so the three
 * numbers the run lifecycle wants — cold, warm, hot — all land in one record. Only reporting
 * the hot number hides how long a system takes to become useful.
 */
const COLD_MS = argOf('cold-ms', null);

/** Resident CPU time of the target process, so per-step CPU can be attributed. */
async function targetCpuSeconds(pid) {
	if (!pid) return null;
	try {
		const { stdout } = await execFileAsync('ps', ['-o', 'time=', '-p', String(pid)]);
		const parts = stdout.trim().split(/[:.]/).map(Number);
		if (parts.length < 3) return null;
		const [h, m, s] = parts.length === 4 ? parts : [0, parts[0], parts[1]];
		return h * 3600 + m * 60 + s;
	} catch {
		return null;
	}
}

async function findHarperPid() {
	try {
		const { stdout } = await execFileAsync('bash', ['-lc', "ps -A -o pid=,command= | grep -i 'harper' | grep -v grep | head -1"]);
		const pid = Number(stdout.trim().split(/\s+/)[0]);
		return Number.isInteger(pid) ? pid : null;
	} catch {
		return null;
	}
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : NaN);

/**
 * Drive one step of the ladder at a constant arrival rate.
 *
 * Arrivals are scheduled against a fixed timeline rather than `setInterval`, so a slow
 * target cannot slow the offered rate — the defining property of an open model.
 */
async function step({ rate, seconds, nextRequest, nextWrite, writeRate, label }) {
	const samples = [];
	const inFlight = new Set();
	const startedAt = performance.now();
	const cpuBefore = process.cpuUsage();

	let issued = 0;
	let writesIssued = 0;
	let shed = 0;
	const totalRequests = Math.round(rate * seconds);
	const totalWrites = Math.round(writeRate * seconds);

	const issue = async (request) => {
		const t0 = performance.now();
		try {
			const response = await fetch(request.url, {
				method: request.method,
				headers: request.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
				body: request.method === 'POST' ? '{}' : undefined,
			});
			// Discard the body without materializing it. Buffering every response at high
			// arrival rates is its own source of generator memory pressure, and byte counts
			// are available from content-length without holding the payload.
			const bytes = Number(response.headers.get('content-length') ?? 0);
			const serverTiming = response.headers.get('server-timing') ?? null;
			await response.body?.cancel();
			samples.push({ kind: request.kind, ms: performance.now() - t0, status: response.status, bytes, serverTiming });
		} catch (error) {
			samples.push({ kind: request.kind, ms: performance.now() - t0, status: 0, error: String(error.message ?? error) });
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

	const postWrite = async (body) => {
		try {
			await fetch(OPS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		} catch {
			/* writes are not under test; their failures are counted, not timed */
		}
	};

	const track = (promise) => {
		inFlight.add(promise);
		promise.finally(() => inFlight.delete(promise));
	};

	const deadline = startedAt + seconds * 1000;
	while (performance.now() < deadline) {
		const elapsed = performance.now() - startedAt;
		const dueRequests = Math.min(totalRequests, Math.floor(elapsed / requestInterval));
		while (issued < dueRequests) {
			if (inFlight.size >= MAX_IN_FLIGHT) {
				// Count every arrival we could not offer, then jump the cursor so the backlog
				// does not replay as a burst the moment capacity frees up.
				shed += dueRequests - issued;
				issued = dueRequests;
				break;
			}
			track(issue(nextRequest()));
			issued++;
		}
		if (writeRate > 0) {
			const dueWrites = Math.min(totalWrites, Math.floor(elapsed / writeInterval));
			while (writesIssued < dueWrites) {
				track(postWrite(nextWrite()));
				writesIssued++;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, TICK_MS));
	}

	// Drain whatever is still outstanding.
	const drainDeadline = performance.now() + 30_000;
	while (inFlight.size > 0 && performance.now() < drainDeadline) {
		await Promise.race([...inFlight, new Promise((r) => setTimeout(r, 100))]);
	}

	const wall = (performance.now() - startedAt) / 1000;
	const cpu = process.cpuUsage(cpuBefore);
	const generatorCpuSeconds = (cpu.user + cpu.system) / 1e6;

	const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
	const latencies = ok.map((s) => s.ms).sort((a, b) => a - b);

	return {
		label,
		offeredRate: rate,
		seconds,
		issued,
		shed,
		writesIssued,
		completed: samples.length,
		ok: ok.length,
		errors: samples.length - ok.length,
		achievedRate: samples.length / wall,
		p50: quantile(latencies, 0.5),
		p90: quantile(latencies, 0.9),
		p99: quantile(latencies, 0.99),
		max: latencies.at(-1) ?? NaN,
		generatorCpuSeconds,
		// One core's worth of the generator's own budget. Past ~0.8 the generator is a
		// plausible bottleneck and the step must not be reported as a target measurement.
		generatorCpuLoad: generatorCpuSeconds / wall,
		// A step that shed arrivals exceeded the target's capacity; its achieved rate is a
		// lower bound on throughput, not a measurement of it.
		saturated: shed > 0,
		samples,
	};
}

// --- run ---------------------------------------------------------------------------------

const manifest = JSON.parse(await (await fetch(`file://${join(DATASET, 'MANIFEST.json')}`).catch(() => null))?.text?.() ?? 'null')
	?? JSON.parse(await (await import('node:fs/promises')).readFile(join(DATASET, 'MANIFEST.json'), 'utf8'));

console.log(`target ${BASE_URL} · dataset scale ${manifest.scale} seed ${manifest.seed}`);
console.log(`${cpus().length} cpus · ${(totalmem() / 1024 ** 3).toFixed(1)} GiB · ${platform()} ${release()}\n`);

const [cartIds, productIds, skus] = await Promise.all([
	sampleIds(DATASET, 'cart', 'id', 20_000),
	sampleIds(DATASET, 'product', 'id', 20_000),
	sampleIds(DATASET, 'variant', 'sku', 20_000),
]);

const nextRequest = makeRequestFactory({ baseUrl: BASE_URL, cartIds, productIds, quoteShare: QUOTE_SHARE });
const nextWrite = makeWriterFactory({ opsUrl: OPS_URL, skus });
const pid = await findHarperPid();

// COLD is measured by the caller restarting the target; this harness reports the first
// observation of the warm-up step separately so the number is not silently lost.
console.log(`warm-up ${WARMUP}s (not reported as a result)`);
const warm = await step({ rate: RATES[0], seconds: WARMUP, nextRequest, nextWrite, writeRate: WRITE_RATE, label: 'warmup' });
console.log(`  first response ${warm.samples[0]?.ms?.toFixed(1)}ms · ${warm.errors} errors\n`);

console.log('rate   offered  achieved   p50      p90      p99      max     errors  genCPU');
console.log('─'.repeat(82));

const steps = [];
for (const rate of RATES) {
	const cpuBefore = await targetCpuSeconds(pid);
	const result = await step({ rate, seconds: DURATION, nextRequest, nextWrite, writeRate: WRITE_RATE, label: `rate-${rate}` });
	const cpuAfter = await targetCpuSeconds(pid);
	result.targetCpuSeconds = cpuBefore !== null && cpuAfter !== null ? cpuAfter - cpuBefore : null;
	steps.push(result);

	let flag = result.generatorCpuLoad > 0.8 ? '  ⚠ GENERATOR saturated — not a target measurement' : '';
	if (result.shed > 0) flag += `  ⚠ shed ${result.shed} (target over capacity)`;
	console.log(
		`${String(rate).padStart(5)}  ${String(result.issued).padStart(7)}  ` +
			`${result.achievedRate.toFixed(1).padStart(8)}  ${result.p50.toFixed(1).padStart(7)}  ` +
			`${result.p90.toFixed(1).padStart(7)}  ${result.p99.toFixed(1).padStart(7)}  ` +
			`${result.max.toFixed(0).padStart(7)}  ${String(result.errors).padStart(6)}  ` +
			`${result.generatorCpuLoad.toFixed(2).padStart(6)}${flag}`
	);
}

await mkdir(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(OUT, `run-${stamp}.json`);
await writeFile(
	file,
	JSON.stringify(
		{
			// Exact run conditions, recorded with the result — not reconstructed later.
			conditions: {
				target: BASE_URL,
				dataset: { scale: manifest.scale, seed: manifest.seed, generatorVersion: manifest.generatorVersion, files: manifest.files },
				host: { cpus: cpus().length, model: cpus()[0]?.model, totalmemGiB: +(totalmem() / 1024 ** 3).toFixed(1), platform: platform(), release: release() },
				harness: { quoteShare: QUOTE_SHARE, writeRate: WRITE_RATE, durationSeconds: DURATION, warmupSeconds: WARMUP, maxInFlight: MAX_IN_FLIGHT },
			lifecycle: {
				coldStartMs: COLD_MS === null ? null : Number(COLD_MS),
				warmupFirstResponseMs: warm.samples[0]?.ms ?? null,
			},
				caveats: [
					'CPU clock NOT pinned — no cycle-normalized efficiency figure may be derived from this run.',
					'Generator shares a host with the target; see generatorCpuLoad per step.',
				],
			},
			steps,
		},
		null,
		2
	)
);
console.log(`\nraw samples retained: ${file}`);
