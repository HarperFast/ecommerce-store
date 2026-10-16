/**
 * Durability of acknowledged writes — WRITE-005, observed rather than declared.
 *
 * No response shows whether a write was synced, and a configuration file can say one thing
 * while the engine does another: Harper 5.3.2 documents fsync as its default and never calls
 * it on RocksDB (HarperFast/harper#3243). So this traces the source of truth's processes for
 * the sync family while it sends writes through the write surface one at a time, and requires
 * a sync inside every write's own interval (scripts/durability.mjs says why one at a time).
 *
 * Linux only, with strace, and permission to trace the processes: root, or
 * `kernel.yama.ptrace_scope=0` and the same user. `--pid` names every process of the source
 * of truth, as the host sees them: the Harper process, or every Postgres process (backends
 * commit their own WAL). For a container, `docker top <container> -eo pid`.
 *
 *   node scripts/verify-durability.mjs --url http://localhost:9926 --pid 1234[,5678...] [--writes 50]
 *
 * Writes one variant's price and restores it. Known to fail against the reference on Harper
 * 5.3.2 (SPEC.md#review-gate).
 *
 * COVERS: WRITE-005
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, productSearchParams } from '@ecommerce-store/spec';
import { SYNC_CALLS, judgeDurability, parseStrace } from './durability.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = argOf('url', 'http://localhost:9926');
const PIDS = (argOf('pid', '') ?? '').split(',').filter(Boolean);
const WRITES = Number(argOf('writes', '50'));
const PRODUCT = argOf('product', 'product-000001');
if (!PIDS.length) {
	console.error('usage: node scripts/verify-durability.mjs --url <target> --pid <pid>[,<pid>...] [--writes 50]');
	process.exit(2);
}

const view = await (await fetch(`${BASE_URL}${API.product(PRODUCT)}?${productSearchParams({ tier: 'standard', region: 'us-east' })}`)).json();
const { sku, basePrice: original } = view.variants[0];

async function writePrice(basePrice) {
	const response = await fetch(`${BASE_URL}/admin/variant/${encodeURIComponent(sku)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ basePrice }),
	});
	await response.arrayBuffer();
	if (!response.ok) throw new Error(`write ${sku}: ${response.status}`);
}

const dir = await mkdtemp(join(tmpdir(), 'durability-'));
const log = join(dir, 'strace.log');
// A regex rather than a list: strace refuses a syscall name its platform lacks, and
// `sync_file_range2` exists on arm64 but not on x86-64.
const filter = `trace=/^(${SYNC_CALLS.join('|')})$`;
const strace = spawn('strace', ['-f', '-ttt', '-T', '-y', '-qq', '-e', filter, '-o', log, ...PIDS.flatMap((pid) => ['-p', pid])], { stdio: ['ignore', 'ignore', 'inherit'] });
const exited = new Promise((resolve, reject) => {
	strace.on('error', reject);
	strace.on('exit', resolve);
});

// Attached once the kernel names a tracer for every process; until then a sync goes unseen.
const traced = async (pid) => Number((await readFile(`/proc/${pid}/status`, 'utf8')).match(/^TracerPid:\s+(\d+)/m)?.[1]) > 0;
for (let attempt = 0; ; attempt++) {
	if ((await Promise.all(PIDS.map(traced))).every(Boolean)) break;
	if (attempt === 100 || strace.exitCode !== null) throw new Error('strace did not attach to every process; see its error above');
	await sleep(100);
}

const writes = [];
try {
	// Two unjudged writes first, so a lazily opened file or a first-write path is not judged.
	await writePrice(original + 1);
	await writePrice(original + 2);
	for (let i = 0; i < WRITES; i++) {
		const sentMs = Date.now();
		await writePrice(original + 3 + i);
		writes.push({ sentMs, ackedMs: Date.now() });
	}
} finally {
	await writePrice(original);
	await sleep(200);
	strace.kill('SIGINT');
	await exited;
}

const { holds, detail } = judgeDurability(writes, parseStrace(await readFile(log, 'utf8')));
await rm(dir, { recursive: true, force: true });

console.log(`durability: ${sku} via ${BASE_URL}, tracing ${PIDS.join(',')}`);
for (const line of detail) console.log(`  ${line}`);
if (!holds) {
	console.error('\nFAIL — WRITE-005: acknowledged writes were not synced to stable storage before acknowledgement.');
	process.exit(1);
}
console.log('\nOK — every acknowledged write was synced before it was acknowledged.');
