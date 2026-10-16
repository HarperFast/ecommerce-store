/**
 * WRITE-005's evidence (durability.mjs), on synthetic strace logs: a database that syncs each
 * commit, the reference on Harper 5.3.2, which syncs none, and calls that look like syncs but
 * do not make this write durable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeDurability, parseStrace } from './durability.mjs';

const T0 = 1_760_000_000_000;
const sec = (ms) => ((T0 + ms) / 1000).toFixed(6);
/** Ten sequential writes, each sent at 10i ms and acknowledged 4 ms later. */
const writes = Array.from({ length: 10 }, (_, i) => ({ sentMs: T0 + i * 10, ackedMs: T0 + i * 10 + 4 }));
const WAL = '12</var/lib/postgresql/data/pg_wal/000000010000000000000001>';
const TXNLOG = '14</db/transaction_logs/local/1.txnlog>';
/** One line per write: `make(i)` returns the lines traced inside write i's interval. */
const trace = (make) => writes.flatMap((_, i) => make(i)).join('\n');
const walAppend = (i, at = 1) => `431 ${sec(i * 10 + at)} pwrite64(${WAL}, "x"..., 8192, 0) = 8192 <0.000040>`;

test('a WAL append synced inside every write holds', () => {
	const result = judgeDurability(writes, parseStrace(trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} fdatasync(${WAL}) = 0 <0.000800>`])));
	assert.equal(result.holds, true);
	assert.match(result.detail[0], /10 sequential acknowledged writes, 10 made durable before acknowledgement \(fdatasync of the written file 10\)/);
	assert.match(result.detail[3], /10 to \/var\/lib\/postgresql\/data\/pg_wal\//);
});

test('appends with no sync fail every write, as on Harper 5.3.2 with RocksDB', () => {
	const result = judgeDurability(writes, parseStrace(trace((i) => [`9 ${sec(i * 10 + 2)} writev(${TXNLOG}, [{iov_base="x", iov_len=1}], 1) = 1 <0.000020>`])));
	assert.equal(result.holds, false);
	assert.equal(result.unsynced.length, 10);
	assert.match(result.detail[3], /10 to \/db\/transaction_logs\/local\/1\.txnlog/);
});

test('a sync of a file the write did not touch proves nothing', () => {
	const unrelated = trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} fdatasync(7</unrelated/log>) = 0 <0.000800>`]);
	assert.equal(judgeDurability(writes, parseStrace(unrelated)).holds, false, 'an unrelated file every interval');
	const background = [walAppend(3), `77 ${sec(33)} fsync(9</data/000123.sst>) = 0 <0.001000>`].join('\n');
	assert.equal(judgeDurability(writes, parseStrace(background)).unsynced.length, 10, 'a background flush');
});

test('a sync before the write, after the acknowledgement, or failed does not count', () => {
	const before = trace((i) => [`431 ${sec(i * 10 + 0.5)} fdatasync(${WAL}) = 0 <0.000100>`, walAppend(i, 1)]);
	assert.equal(judgeDurability(writes, parseStrace(before)).holds, false, 'synced before the append');
	const late = trace((i) => [walAppend(i), `431 ${sec(i * 10 + 3)} fdatasync(${WAL}) = 0 <0.003000>`]);
	assert.equal(judgeDurability(writes, parseStrace(late)).holds, false, 'finishing 2 ms after the acknowledgement');
	const failed = trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} fdatasync(${WAL}) = -1 EIO (Input/output error) <0.000010>`]);
	assert.equal(judgeDurability(writes, parseStrace(failed)).holds, false, 'EIO is not a sync');
});

test('sync_file_range and msync without MS_SYNC are not barriers; msync with MS_SYNC is', () => {
	const range = trace((i) => [walAppend(i), `431 ${sec(i * 10 + 2)} sync_file_range(${WAL}, 0, 0, 0) = 0 <0.000010>`]);
	const rangeResult = judgeDurability(writes, parseStrace(range));
	assert.equal(rangeResult.holds, false);
	assert.match(rangeResult.detail[1], /10 of them not durability barriers/);
	const async = trace((i) => [`88 ${sec(i * 10 + 2)} msync(0xffff0000, 4096, MS_ASYNC) = 0 <0.000010>`]);
	assert.equal(judgeDurability(writes, parseStrace(async)).holds, false, 'MS_ASYNC');
	const sync = trace((i) => [`88 ${sec(i * 10 + 2)} msync(0xffff0000, 4096, MS_SYNC) = 0 <0.000500>`]);
	assert.equal(judgeDurability(writes, parseStrace(sync)).holds, true, 'MS_SYNC');
});

test('a write to a descriptor opened O_DSYNC is durable when it returns', () => {
	const log = parseStrace(trace((i) => [walAppend(i)]));
	assert.equal(judgeDurability(writes, log).holds, false, 'without the descriptor flags');
	const result = judgeDurability(writes, log, new Set([`431:12:/var/lib/postgresql/data/pg_wal/000000010000000000000001`]));
	assert.equal(result.holds, true);
	assert.match(result.detail[0], /O_DSYNC write 10/);
});

test('a call interrupted by another thread is joined across its unfinished and resumed lines', () => {
	const log = trace((i) => [
		walAppend(i, 0.5),
		`501 ${sec(i * 10 + 1)} fdatasync(${WAL} <unfinished ...>`,
		`502 ${sec(i * 10 + 2)} write(3<socket:[4242]>, "HTTP/1.1 200"..., 120) = 120 <0.000010>`,
		`501 ${sec(i * 10 + 3)} <... fdatasync resumed>) = 0 <0.002000>`,
	]);
	const calls = parseStrace(log);
	assert.equal(calls.filter((c) => c.call === 'fdatasync').length, 10);
	assert.equal(calls.find((c) => c.call === 'fdatasync').path, '/var/lib/postgresql/data/pg_wal/000000010000000000000001');
	const result = judgeDurability(writes, calls);
	assert.equal(result.holds, true);
	assert.doesNotMatch(result.detail.join('\n'), /socket/, 'socket writes are not file writes');
});
