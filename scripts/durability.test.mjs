/**
 * WRITE-005's evidence (durability.mjs), on synthetic strace logs: a database that syncs each
 * commit, the reference on Harper 5.3.2, which syncs none, calls that look like syncs but do
 * not make this write's log durable, and descriptors whose flags change during the run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptorFlags, judgeDurability, parseStrace } from './durability.mjs';

const T0 = 1_760_000_000_000;
const sec = (ms) => ((T0 + ms) / 1000).toFixed(6);
/** Ten sequential writes, each sent at 10i ms and acknowledged 4 ms later. */
const writes = Array.from({ length: 10 }, (_, i) => ({ sentMs: T0 + i * 10, ackedMs: T0 + i * 10 + 4 }));
const WAL_PATH = '/var/lib/postgresql/data/pg_wal/000000010000000000000001';
const WAL = `12<${WAL_PATH}>`;
const TXNLOG = '14</db/transaction_logs/local/1.txnlog>';
/** Lines traced inside each write's interval, by `make(i)`. */
const trace = (make) => writes.flatMap((_, i) => make(i)).join('\n');
const walAppend = (i, at = 1) => `431 ${sec(i * 10 + at)} pwrite64(${WAL}, "x"..., 8192, 0) = 8192 <0.000040>`;
const walSync = (i, at = 2) => `431 ${sec(i * 10 + at)} fdatasync(${WAL}) = 0 <0.000800>`;
const judge = (lines, flags) => judgeDurability(writes, parseStrace(lines), { log: '/pg_wal/', flags });

test('a WAL append synced inside every write holds', () => {
	const result = judge(trace((i) => [walAppend(i), walSync(i)]));
	assert.equal(result.verdict, 'holds');
	assert.match(result.detail[0], /10 durable, 0 not, 0 inconclusive \(fdatasync after the log write 10\)/);
	assert.match(result.detail[3], /10 to \/var\/lib\/postgresql\/data\/pg_wal\//);
});

test('log appends with no sync fail, as on Harper 5.3.2 with RocksDB', () => {
	const calls = parseStrace(trace((i) => [`9 ${sec(i * 10 + 2)} writev(${TXNLOG}, [{iov_base="x", iov_len=1}], 1) = 1 <0.000020>`]));
	const { flags } = descriptorFlags(calls, { tasks: new Map([[9, 9]]), snapshot: new Map([['9:14', { path: '/db/transaction_logs/local/1.txnlog', dsync: false }]]), snapshotMs: T0 - 1000 });
	const result = judgeDurability(writes, calls, { log: '/transaction_logs/', flags });
	assert.equal(result.verdict, 'fails');
	assert.match(result.detail[0], /0 durable, 10 not/);
});

test('a sync of another file proves nothing, even one the interval also wrote', () => {
	const unrelated = (i) => [`431 ${sec(i * 10 + 1.5)} write(7</unrelated/log>, "y", 1) = 1 <0.000010>`, `431 ${sec(i * 10 + 2)} fdatasync(7</unrelated/log>) = 0 <0.000800>`];
	const calls = parseStrace(trace((i) => [walAppend(i), ...unrelated(i)]));
	const flags = new Map(calls.filter((c) => c.path === WAL_PATH).map((c) => [c, false]));
	assert.equal(judgeDurability(writes, calls, { log: '/pg_wal/', flags }).verdict, 'fails');
});

test('a sync before the log write, after the acknowledgement, or failed does not count', () => {
	const notDsync = (lines) => {
		const calls = parseStrace(lines);
		return judgeDurability(writes, calls, { log: '/pg_wal/', flags: new Map(calls.map((c) => [c, false])) }).verdict;
	};
	assert.equal(notDsync(trace((i) => [walSync(i, 0.5), walAppend(i, 1)])), 'fails', 'synced before the append');
	assert.equal(notDsync(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 3)} fdatasync(${WAL}) = 0 <0.003000>`])), 'fails', 'finishing 2 ms after the acknowledgement');
	assert.equal(notDsync(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} fdatasync(${WAL}) = -1 EIO (Input/output error) <0.000010>`])), 'fails', 'EIO is not a sync');
	assert.equal(notDsync(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} sync_file_range(${WAL}, 0, 0, 0) = 0 <0.000010>`])), 'fails', 'sync_file_range only starts writeback');
	assert.equal(notDsync(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} msync(0xffff0000, 4096, MS_SYNC) = 0 <0.000500>`])), 'fails', 'msync cannot be tied to the log');
	assert.equal(notDsync(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} sync() = 0 <0.001000>`])), 'holds', 'sync() flushes everything');
});

test('an interval with no log write, or unknown flags and no sync, is inconclusive', () => {
	assert.equal(judge(trace((i) => [`431 ${sec(i * 10 + 2)} fdatasync(7</unrelated/log>) = 0 <0.000800>`])).verdict, 'inconclusive', 'no log write');
	assert.equal(judge(trace((i) => [walAppend(i)])).verdict, 'inconclusive', 'flags never established');
});

test('O_DSYNC is judged by the flags each write ran with, opens and closes replayed', () => {
	const tasks = new Map([[431, 430]]);
	const opened = `431 ${sec(-500)} openat(AT_FDCWD</var/lib/postgresql/data>, "pg_wal/000000010000000000000001", O_WRONLY|O_DSYNC|O_CLOEXEC) = 12<${WAL_PATH}> <0.000030>`;
	const dsync = parseStrace([opened, trace((i) => [walAppend(i)])].join('\n'));
	const fromOpen = judgeDurability(writes, dsync, { log: '/pg_wal/', flags: descriptorFlags(dsync, { tasks, snapshot: new Map(), snapshotMs: T0 - 1000 }).flags });
	assert.equal(fromOpen.verdict, 'holds', 'opened O_DSYNC during the trace');
	assert.match(fromOpen.detail[0], /O_DSYNC log write 10/);

	const { flags: fromSnapshot } = descriptorFlags(parseStrace(trace((i) => [walAppend(i)])), { tasks, snapshot: new Map([['430:12', { path: WAL_PATH, dsync: true }]]), snapshotMs: T0 - 1000 });
	assert.ok([...fromSnapshot.values()].every((d) => d === true), 'open before the trace, flags from the snapshot');

	// Reopened without O_DSYNC halfway through: the later writes are not durable.
	const reopened = parseStrace([
		trace((i) => (i < 5 ? [walAppend(i)] : [])),
		`431 ${sec(45)} close(${WAL}) = 0 <0.000010>`,
		`431 ${sec(46)} openat(AT_FDCWD</var/lib/postgresql/data>, "pg_wal/000000010000000000000001", O_WRONLY|O_CLOEXEC) = 12<${WAL_PATH}> <0.000030>`,
		trace((i) => (i >= 5 ? [walAppend(i, 2)] : [])),
	].join('\n'));
	const { flags } = descriptorFlags(reopened, { tasks, snapshot: new Map([['430:12', { path: WAL_PATH, dsync: true }]]), snapshotMs: T0 - 1000 });
	const result = judgeDurability(writes, reopened, { log: '/pg_wal/', flags });
	assert.equal(result.verdict, 'fails');
	assert.match(result.detail[0], /5 durable, 5 not/);
});

test('per-write RWF_DSYNC is synchronous whatever the descriptor', () => {
	const calls = parseStrace(trace((i) => [`431 ${sec(i * 10 + 1)} pwritev2(${WAL}, [{iov_base="x", iov_len=8192}], 1, 0, RWF_DSYNC) = 8192 <0.000400>`]));
	const { flags } = descriptorFlags(calls, { tasks: new Map([[431, 430]]), snapshot: new Map([['430:12', { path: WAL_PATH, dsync: false }]]), snapshotMs: T0 - 1000 });
	assert.equal(judgeDurability(writes, calls, { log: '/pg_wal/', flags }).verdict, 'holds');
});

test('what the trace cannot tie to the log is inconclusive, not a pass', () => {
	const tasks = new Map([[431, 430]]);
	const known = (calls) => descriptorFlags(calls, { tasks, snapshot: new Map([['430:12', { path: WAL_PATH, dsync: false }]]), snapshotMs: T0 - 1000 });
	const verdictOf = (lines) => {
		const calls = parseStrace(lines);
		const { flags, created } = known(calls);
		return judgeDurability(writes, calls, { log: '/pg_wal/', flags, created }).verdict;
	};
	assert.equal(verdictOf(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} syncfs(9</mnt/b/pg_wal/other>) = 0 <0.000500>`])), 'inconclusive', 'syncfs on a filesystem the trace cannot name');

	const created = `431 ${sec(-500)} openat(AT_FDCWD</var/lib/postgresql/data>, "pg_wal/000000010000000000000001", O_WRONLY|O_CREAT|O_EXCL) = 12<${WAL_PATH}> <0.000030>`;
	assert.equal(verdictOf([created, trace((i) => [walAppend(i), walSync(i)])].join('\n')), 'inconclusive', 'a new log file whose directory was never synced');
	const dirSync = `431 ${sec(-400)} fsync(13</var/lib/postgresql/data/pg_wal>) = 0 <0.000500>`;
	assert.equal(verdictOf([created, dirSync, trace((i) => [walAppend(i), walSync(i)])].join('\n')), 'holds', 'its directory synced after creation');

	// The snapshot was being read while fd 12 was duplicated: neither copy's flags are known.
	const racing = parseStrace([`431 ${sec(-995)} dup2(${WAL}, 13) = 13<${WAL_PATH}> <0.000010>`, trace((i) => [walAppend(i).replace('pwrite64(12<', 'pwrite64(13<')])].join('\n'));
	const { flags: raceFlags } = descriptorFlags(racing, { tasks, snapshot: new Map([['430:12', { path: WAL_PATH, dsync: true }]]), snapshotMs: T0 - 1000, snapshotEndMs: T0 - 990 });
	assert.equal(judgeDurability(writes, racing, { log: '/pg_wal/', flags: raceFlags }).verdict, 'inconclusive', 'dup during the snapshot');

	// A dup2 onto fd 12 overlapping a write through it: the write's flags are unknown.
	const overlapping = parseStrace([trace((i) => [walAppend(i)]), `431 ${sec(1.01)} dup2(5</var/lib/postgresql/data/pg_wal/x>, 12) = 12<${WAL_PATH}> <0.000100>`].join('\n'));
	const { flags: overlapFlags } = descriptorFlags(overlapping, { tasks, snapshot: new Map([['430:12', { path: WAL_PATH, dsync: true }]]), snapshotMs: T0 - 1000 });
	assert.equal(judgeDurability(writes, overlapping, { log: '/pg_wal/', flags: overlapFlags }).verdict, 'inconclusive', 'replaced mid-write');
});

test('a call interrupted by another thread is joined across its unfinished and resumed lines', () => {
	const calls = parseStrace(trace((i) => [
		walAppend(i, 0.5),
		`501 ${sec(i * 10 + 1)} fdatasync(${WAL} <unfinished ...>`,
		`502 ${sec(i * 10 + 2)} write(3<socket:[4242]>, "HTTP/1.1 200"..., 120) = 120 <0.000010>`,
		`501 ${sec(i * 10 + 3)} <... fdatasync resumed>) = 0 <0.002000>`,
	]));
	assert.equal(calls.filter((c) => c.call === 'fdatasync').length, 10);
	assert.equal(calls.find((c) => c.call === 'fdatasync').path, WAL_PATH);
	const result = judgeDurability(writes, calls, { log: '/pg_wal/' });
	assert.equal(result.verdict, 'holds');
	assert.doesNotMatch(result.detail.join('\n'), /socket/, 'socket writes are not log writes');
});
