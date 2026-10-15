/**
 * The tier-2 cycle join (bench/cycles.mjs), against real perf output from the tier-2
 * qualification and against output in sample.sh's per-cgroup layout.
 *
 * fixtures/perf-probe-c4-target-only.csv is probe-clock.sh's per-CPU output from the C4
 * qualification session (application-architecture-benchmarks 68b7a3c,
 * environments/gcp/qualification/2026-10-14-c4-standard-16-lssd/probe-1): both target CPUs busy,
 * 3.898 GHz. sample.sh's own per-cgroup perf.csv has not been captured from a real session yet,
 * so its layout below follows perf's CSV format (`time,value,unit,event,cgroup,...`) and is
 * untested against the real thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { joinCycles, parsePerfCsv } from './cycles.mjs';

const PERF_START = 1_800_000_000_000;
const step = (label, fromMs, toMs, extra = {}) => ({ label, startedAtEpochMs: PERF_START + fromMs, drainEndEpochMs: PERF_START + toMs, ok: 10_000, targetCpuSeconds: null, ...extra });

test('real probe output: per-CPU rows join to the measured clock', async () => {
	const rows = parsePerfCsv(await readFile(new URL('./fixtures/perf-probe-c4-target-only.csv', import.meta.url), 'utf8'));
	assert.ok(rows.some((r) => r.group === 'CPU2' && r.event === 'cycles'));
	assert.ok(rows.some((r) => r.group === 'CPU3' && r.event === 'task-clock'), 'cpu-clock [software] reads as CPU time');
	const record = { steps: [step('rate-a', 2_500, 30_250), step('rate-b', 30_250, 54_000)] };
	const { steps, summary } = joinCycles(record, { rows, perfStartEpochMs: PERF_START, target: ['CPU2', 'CPU3'], generator: [] });
	for (const { cycles } of steps) {
		assert.ok(cycles.coverage > 0.999);
		assert.ok(cycles.target.effectiveGHz > 3.89 && cycles.target.effectiveGHz < 3.90, `${cycles.target.effectiveGHz} GHz`);
		assert.equal(cycles.target.ipc, null, 'the probe counts no instructions');
		assert.equal(cycles.generator, null);
	}
	// Both CPUs busy: about two CPU-seconds per second of window.
	const [a] = steps;
	assert.ok(Math.abs(a.cycles.target.cpuSeconds / 27.75 - 2) < 0.01, `${a.cycles.target.cpuSeconds} CPU-s`);
	assert.ok(Math.abs(a.cycles.opsPerGigacycle - 10_000 / a.cycles.target.gigacycles) < 1e-9);
	assert.equal(summary.intervalMs > 999 && summary.intervalMs < 1002, true);
	assert.ok(summary.effectiveGHz.spreadPct < 0.3);
});

/** sample.sh's layout: 250 ms intervals, one row per event per slice. */
function samplePerfCsv(seconds) {
	const lines = ['# started on Thu Oct 15 20:00:00 2026', ''];
	for (let k = 1; k <= seconds * 4; k++) {
		const t = (k * 0.25).toFixed(9);
		const target = 'bench.slice/bench-target.slice';
		const generator = 'bench.slice/bench-generator.slice';
		lines.push(`${t},1900000000,,cycles,${target},250000000,100.00,3.800,GHz`);
		lines.push(`${t},2850000000,,instructions,${target},250000000,100.00,1.50,insn per cycle`);
		lines.push(`${t},500.00,msec,task-clock,${target},250000000,100.00,2.000,CPUs utilized`);
		lines.push(`${t},200000000,,cycles,${generator},250000000,100.00,4.000,GHz`);
		lines.push(`${t},<not counted>,,instructions,${generator},0,0.00,,`);
		lines.push(`${t},50.00,msec,task-clock,${generator},250000000,100.00,0.200,CPUs utilized`);
	}
	return lines.join('\n');
}

test("sample.sh's per-cgroup layout: proration at step edges, generator, IPC, ops per gigacycle", () => {
	const rows = parsePerfCsv(samplePerfCsv(20));
	// 1.125 s to 9.875 s: both edges cut an interval in half; 35 intervals' worth in all.
	const record = { steps: [step('rate-100', 1_125, 9_875, { ok: 13_300, targetCpuSeconds: 17.5 })] };
	const [{ cycles }] = joinCycles(record, { rows, perfStartEpochMs: PERF_START }).steps;
	const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9 * Math.max(1, expected), `${actual} != ${expected}`);
	close(cycles.target.gigacycles, 66.5);
	close(cycles.target.cpuSeconds, 17.5);
	close(cycles.target.effectiveGHz, 3.8);
	close(cycles.target.ipc, 1.5);
	close(cycles.opsPerGigacycle, 200);
	close(cycles.generator.gigacycles, 7);
	close(cycles.generator.effectiveGHz, 4);
	close(cycles.cpuAgreement, 1);
});

test('a step the samples do not cover has no cycle figure, and says why', () => {
	const rows = parsePerfCsv(samplePerfCsv(10));
	const record = { steps: [step('rate-50', 2_000, 8_000), step('rate-100', 9_000, 15_000), step('no-times', NaN, NaN)] };
	const [inside, past, untimed] = joinCycles(record, { rows, perfStartEpochMs: PERF_START }).steps;
	assert.ok(inside.cycles);
	assert.equal(past.cycles, null);
	assert.match(past.reason, /cover 16\.7% of the step/);
	assert.equal(untimed.cycles, null);
});
