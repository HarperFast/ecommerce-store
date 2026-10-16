/**
 * Durability of acknowledged writes — WRITE-005, observed rather than declared.
 *
 * No response shows whether a write was synced, and a configuration file can say one thing
 * while the engine does another: Harper 5.3.2 documents fsync as its default and never calls
 * it on RocksDB (HarperFast/harper#3243). So this traces the source of truth's processes while
 * it sends writes through the write surface one at a time, and requires each write to make its
 * commit log durable before it is acknowledged (scripts/durability.mjs says what counts).
 *
 * Linux only, with strace, and permission to trace the processes: root, or
 * `kernel.yama.ptrace_scope=0` and the same user. `--pid` names every process of the source of
 * truth, as the host sees them: the Harper process, or every Postgres process (backends commit
 * their own WAL). For a container, `docker top <container> -eo pid`. `--log` is a fragment of
 * the commit log's path: `/transaction_logs/` for Harper on RocksDB, `/pg_wal/` for Postgres.
 *
 *   node scripts/verify-durability.mjs --url http://localhost:9926 --pid 1234[,5678...] --log /pg_wal/ [--writes 50]
 *
 * Exits 0 when WRITE-005 holds, 1 when it fails, and 2 when the evidence is inconclusive or the
 * trace could not be taken, so neither reads as a verdict. Writes one variant's price and
 * restores it. Known to fail against the reference on Harper 5.3.2 (SPEC.md#review-gate).
 *
 * COVERS: WRITE-005
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, productSearchParams } from '@ecommerce-store/spec';
import { O_DSYNC, TRACED, descriptorFlags, judgeDurability, parseStrace } from './durability.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = argOf('url', 'http://localhost:9926');
const PIDS = (argOf('pid', '') ?? '').split(',').filter(Boolean);
const LOG = argOf('log', '');
const WRITES = Number(argOf('writes', '50'));
const PRODUCT = argOf('product', 'product-000001');
if (!PIDS.length || !LOG) {
	console.error('usage: node scripts/verify-durability.mjs --url <target> --pid <pid>[,<pid>...] --log <commit-log path fragment> [--writes 50]');
	process.exit(2);
}
const inconclusive = (message) => {
	console.error(`INCONCLUSIVE — ${message}. No verdict on WRITE-005.`);
	process.exit(2);
};

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
const filter = `trace=/^(${TRACED.join('|')})$`;
const strace = spawn('strace', ['-f', '-ttt', '-T', '-y', '-qq', '-e', filter, '-o', log, ...PIDS.flatMap((pid) => ['-p', pid])], { stdio: ['ignore', 'ignore', 'inherit'] });
let stopping = false;
let died = null;
const exited = new Promise((resolve) => {
	strace.on('error', (error) => inconclusive(`strace could not start: ${error.message}`));
	strace.on('exit', (code, signal) => {
		if (!stopping) died = signal ?? code;
		resolve();
	});
});

// Attached once the kernel names a tracer for every process; until then a write goes unseen.
const tracerOf = async (pid) => Number((await readFile(`/proc/${pid}/status`, 'utf8')).match(/^TracerPid:\s+(\d+)/m)?.[1]);
for (let attempt = 0; ; attempt++) {
	if ((await Promise.all(PIDS.map(tracerOf))).every((tracer) => tracer > 0)) break;
	if (attempt === 100 || died !== null) inconclusive('strace did not attach to every process; see its error above');
	await sleep(100);
}

// Which thread belongs to which process, and what every log descriptor refers to now. Opens,
// dups and closes from here on are in the trace, so flags are known at each later write.
const tasks = new Map();
const snapshot = new Map();
const snapshotMs = Date.now();
for (const pid of PIDS) {
	for (const tid of await readdir(`/proc/${pid}/task`)) tasks.set(Number(tid), Number(pid));
	for (const fd of await readdir(`/proc/${pid}/fd`)) {
		try {
			const path = await readlink(`/proc/${pid}/fd/${fd}`);
			if (!path.includes(LOG)) continue;
			const flags = Number.parseInt((await readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8')).match(/^flags:\s+([0-7]+)/m)[1], 8);
			snapshot.set(`${pid}:${fd}`, { path, dsync: Boolean(flags & O_DSYNC) });
		} catch {
			// Closed while being read: the trace records what replaces it.
		}
	}
}
const snapshotEndMs = Date.now() + 1;

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
	stopping = true;
	strace.kill('SIGINT');
	await exited;
}
if (died !== null) inconclusive(`strace exited during the run (${died}), so the trace is partial`);

const calls = parseStrace(await readFile(log, 'utf8'));
await rm(dir, { recursive: true, force: true });
const { flags, created } = descriptorFlags(calls, { tasks, snapshot, snapshotMs, snapshotEndMs });
const { verdict, detail } = judgeDurability(writes, calls, { log: LOG, flags, created });

console.log(`durability: ${sku} via ${BASE_URL}, tracing ${PIDS.join(',')}`);
for (const line of detail) console.log(`  ${line}`);
if (verdict === 'inconclusive') inconclusive('the trace does not show whether every write reached its commit log durably');
if (verdict === 'fails') {
	console.error('\nFAIL — WRITE-005: acknowledged writes reached the commit log without being made durable.');
	process.exit(1);
}
console.log('\nOK — every acknowledged write made its commit log durable before it was acknowledged.');
