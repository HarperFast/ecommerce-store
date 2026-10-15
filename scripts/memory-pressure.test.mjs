/**
 * DATA-004's memory evidence (memory-pressure.mjs), on synthetic records: a separated stack
 * with a split per-container budget, the single-container reference, and working sets that fit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { memoryPressure } from './memory-pressure.mjs';

const MiB = 2 ** 20;
const BUDGET = 2048 * MiB;

/** A component reading `read` MiB per step; `peak` and `limit` in MiB (limit null: none of its own). */
const component = (name, peak, limit, read) => ({ name, cpuSeconds: 1, memoryPeakSinceStartBytes: peak * MiB, memoryMaxBytes: limit === null ? null : limit * MiB, diskReadBytes: read * MiB, pageCacheRefaults: 0 });
const record = (stepsComponents, budget = BUDGET) => ({
	conditions: { orchestrator: { target: { applied: { memoryBytes: budget } } } },
	steps: stepsComponents.map((targetComponents, i) => ({ label: `rate-${i}`, targetComponents })),
});
const fastify = (postgresPeak, postgresRead) => [component('app', 300, 512, 0), component('postgres', postgresPeak, 1280, postgresRead), component('redis', 180, 256, 0)];

test('a split budget whose database is pinned and paging holds, though the summed peaks are 86% of 2 GiB', () => {
	const result = memoryPressure(record([fastify(1280, 40), fastify(1280, 35), fastify(1280, 52)]));
	assert.equal(result.holds, true);
	assert.match(result.basis, /^per cgroup: postgres against its own 1280 MiB limit/);
	assert.ok(result.detail.some((line) => /^summed: app \+ postgres \+ redis against the 2048 MiB budget: peak 1760 MiB \(86%\)/.test(line)));
});

test('a split budget whose working set fits fails', () => {
	assert.equal(memoryPressure(record([fastify(700, 0), fastify(700, 0)])).holds, false, 'below its limit, reading nothing');
	assert.equal(memoryPressure(record([fastify(1280, 0), fastify(1280, 0)])).holds, false, 'pinned at its limit, but everything it reads is cached');
	assert.equal(memoryPressure(record([fastify(1280, 30), fastify(1280, 0)])).holds, false, 'stopped reading after the first step');
});

test('the single-container reference is judged against its own limit', () => {
	const harper = (peak, read) => [component('harper', peak, 2048, read)];
	const pressed = memoryPressure(record([harper(1990, 20), harper(2010, 25)]));
	assert.equal(pressed.holds, true);
	assert.equal(pressed.detail.length, 1, 'one container: no separate summed basis');
	assert.equal(memoryPressure(record([harper(725, 3), harper(725, 2)])).holds, false, 'the 2026-10-14 ladder: 725 MiB of 2 GiB');
});

test('cgroups without limits of their own are judged together against the budget', () => {
	const open = (peak, read) => [component('app', 400, null, 0), component('db', peak, null, read)];
	const result = memoryPressure(record([open(1500, 10), open(1520, 12)]));
	assert.equal(result.holds, true);
	assert.match(result.basis, /^summed: app \+ db against the 2048 MiB budget/);
	assert.equal(memoryPressure(record([open(1000, 10), open(1000, 12)])).holds, false);
	assert.equal(memoryPressure(record([open(1500, 10)], 0)).holds, false, 'no budget to judge against');
});

test('refaults count as reading back what memory could not hold', () => {
	const harper = (refaults) => [{ ...component('harper', 2000, 2048, 0), pageCacheRefaults: refaults }];
	assert.equal(memoryPressure(record([harper(12), harper(30)])).holds, true);
});

test('verify-run-record.mjs passes DATA-004 memory for the split-budget record and names its basis', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'memory-pressure-'));
	const file = join(dir, 'run.json');
	const run = record([fastify(1280, 40), fastify(1280, 35)]);
	run.conditions.dataset = { scale: 'bench', files: {} };
	await writeFile(file, JSON.stringify(run));
	const { stdout, stderr } = await promisify(execFile)(process.execPath, [new URL('./verify-run-record.mjs', import.meta.url).pathname, file]).catch((error) => error);
	assert.match(stdout, /DATA-004 memory basis: per cgroup: postgres against its own 1280 MiB limit/);
	assert.doesNotMatch(stderr, /DATA-004: no target cgroup/);
});
