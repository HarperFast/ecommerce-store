/**
 * Validate a benchmark run record against the requirements that are properties of the RUN
 * rather than of a request.
 *
 * `DATA-004`, `WRITE-001`, `WRITE-003` and `WRITE-004` cannot be asserted by hitting an
 * endpoint: they are about what the harness offered, what the dataset was, and what the
 * cache actually did while it ran. Forcing them into the HTTP suite would produce tests that
 * assert nothing, so they are checked here, against the artifact the run emits.
 *
 *   node scripts/verify-run-record.mjs [--dev] bench/results/run-....json
 *
 * `--dev` is for development runs against the `dev` dataset, which can never satisfy
 * DATA-004: the scale check becomes a note so the WRITE-* checks still mean something.
 *
 * It also checks the measurement rules a run must meet to be a measurement at all (`METHOD`):
 * target CPU accounted for every step, and no step where the generator saturated.
 *
 * COVERS: DATA-004 WRITE-001 WRITE-003 WRITE-004
 */
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const DEV = args.includes('--dev');
const file = args.find((arg) => !arg.startsWith('--'));
if (!file) {
	console.error('usage: node scripts/verify-run-record.mjs [--dev] <run-record.json>');
	process.exit(2);
}

const record = JSON.parse(await readFile(file, 'utf8'));
const { conditions, steps } = record;
const failures = [];
const notes = [];

const fail = (id, message) => failures.push(`${id}: ${message}`);

// --- DATA-004: one dataset size, working set larger than memory -------------------------
if (conditions.dataset?.scale !== 'bench') {
	const message = `run used the "${conditions.dataset?.scale}" dataset; only "bench" is a benchmark target`;
	if (DEV) notes.push(`DATA-004 not checked (--dev): ${message}`);
	else fail('DATA-004', message);
}
const reachable = conditions.harness?.reachableKeys;
if (!reachable) {
	fail('DATA-004', 'the record does not state how many keys the workload could reach');
} else {
	notes.push(`reachable keys: ${Object.entries(reachable).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
if (conditions.harness?.keySampling !== 'stride across full tables') {
	fail('DATA-004', `key sampling is "${conditions.harness?.keySampling}"; a prefix sample does not establish a working set`);
}

// --- WRITE-001 / WRITE-004: the write stream actually ran, at the configured rate --------
const configuredRate = conditions.harness?.writeRate ?? 0;
if (configuredRate <= 0) {
	fail('WRITE-001', 'no background write stream was configured; cache coherence was never exercised');
}
for (const step of steps) {
	const expected = Math.round(configuredRate * step.seconds);
	if (step.writesIssued === 0 && configuredRate > 0) {
		fail('WRITE-001', `step ${step.label} issued no writes`);
	} else if (expected > 0 && Math.abs(step.writesIssued - expected) > Math.max(2, expected * 0.1)) {
		fail('WRITE-004', `step ${step.label} issued ${step.writesIssued} writes, expected about ${expected}`);
	}
	if (step.writeFailures > 0) {
		fail('WRITE-001', `step ${step.label} had ${step.writeFailures} failed writes — the coherence workload was degraded`);
	}
	if ((step.invalidations ?? 0) === 0 && step.writesIssued > 0) {
		fail('WRITE-001', `step ${step.label} wrote ${step.writesIssued} times and invalidated nothing`);
	}
}

// --- WRITE-003: freshness was NOT achieved by disabling caching --------------------------
for (const step of steps) {
	if (step.cacheHitRate === null || step.cacheObserved === 0) {
		fail('WRITE-003', `step ${step.label} observed no cache status; hit rate cannot be established`);
	} else if (step.cacheHitRate === 0) {
		fail('WRITE-003', `step ${step.label} had a 0% cache hit rate — freshness must not come from disabling caching`);
	}
}

// --- METHOD: measurement rules, not requirements --------------------------------------------
for (const step of steps) {
	if (step.targetCpuSeconds === null || step.targetCpuSeconds === undefined) {
		fail('METHOD', `step ${step.label} has no target CPU figure; per-target CPU is a measurement rule`);
	}
	if (step.generatorCpuLoad > 0.8) {
		fail('METHOD', `step ${step.label}: generator CPU load ${step.generatorCpuLoad.toFixed(2)} — the generator, not the target, may have been the bottleneck`);
	}
	if (step.dispatchLagP99 > 5) {
		notes.push(`step ${step.label}: dispatch lag p99 ${step.dispatchLagP99.toFixed(1)}ms — arrivals left behind schedule`);
	}
}

// --- things that make the record usable at all -------------------------------------------
if (!conditions.code?.commit) notes.push('WARNING: the record does not name the commit that produced it');
else if (conditions.code.dirty) notes.push('WARNING: produced from a dirty working tree — not reproducible');
for (const caveat of conditions.caveats ?? []) notes.push(`caveat: ${caveat}`);

console.log(`run record: ${file}`);
console.log(`  dataset ${conditions.dataset?.scale} seed ${conditions.dataset?.seed} generator ${conditions.dataset?.generatorVersion}`);
console.log(`  ${steps.length} steps, write rate ${configuredRate}/s`);
for (const step of steps) {
	const hit = step.cacheHitRate === null ? 'n/a' : `${(step.cacheHitRate * 100).toFixed(1)}%`;
	const cpu = step.targetCpuSeconds == null ? 'n/a' : `${step.targetCpuSeconds.toFixed(1)}s`;
	console.log(`    ${String(step.label).padEnd(10)} writes ${String(step.writesIssued).padStart(5)} failed ${String(step.writeFailures ?? 0).padStart(4)} invalidated ${String(step.invalidations ?? 0).padStart(6)} cacheHit ${hit} targetCpu ${cpu}`);
}
for (const note of notes) console.log(`  ${note}`);

if (failures.length) {
	console.error(`\nFAIL — ${failures.length} run-level requirement(s) not met:`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log('\nOK — run-level requirements met.');
