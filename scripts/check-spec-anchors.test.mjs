import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SPEC = 'SPEC.md';
const CHECKER = 'scripts/check-spec-anchors.mjs';

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'spec-anchors-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	function write(name, content) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	write(SPEC, '# Root heading\n\n[Local](#root-heading)\n');
	write('docs/guide.md', `[Spec](../${SPEC}#root-heading)\n`);
	mkdirSync(join(root, 'scripts'));
	copyFileSync(new URL('./check-spec-anchors.mjs', import.meta.url), join(root, CHECKER));
	return {
		root,
		write,
		run: () => spawnSync(process.execPath, [join(root, CHECKER)], { cwd: root, encoding: 'utf8' }),
	};
}

test('accepts valid local and cross-file anchors', (t) => {
	const result = fixture(t).run();
	assert.equal(result.status, 0, result.stderr);
});

test('rejects a missing anchor in an ordinary nested directory', (t) => {
	const { write, run } = fixture(t);
	write('docs/nested/guide.md', `[Missing](../../${SPEC}#missing)\n`);
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /docs\/nested\/guide\.md:1.*no such heading/);
});

test('rejects a valid anchor linked through the wrong relative path', (t) => {
	const { write, run } = fixture(t);
	write('docs/guide.md', `[Wrong path](${SPEC}#root-heading)\n`);
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /docs\/guide\.md:1.*links to/);
});

test('rejects missing same-document anchors in the specification', (t) => {
	const { write, run } = fixture(t);
	write(SPEC, '# Root heading\n\n[Missing](#missing)\n');
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no such heading/);
});

for (const kind of ['worktree', 'repository']) {
	test(`ignores a nested Git ${kind} but still checks sibling files`, (t) => {
		const { root, write, run } = fixture(t);
		const nested = '.claude/worktrees/other';
		if (kind === 'worktree') write(`${nested}/.git`, 'gitdir: /unused/worktree/metadata\n');
		else mkdirSync(join(root, nested, '.git'), { recursive: true });
		write(`${nested}/${SPEC}`, '# Other heading\n');
		write(`${nested}/docs/guide.md`, `[Other spec](../${SPEC}#other-heading)\n`);
		write(`${nested}/${CHECKER}`, `// ${SPEC}#checker-example\n`);
		let result = run();
		assert.equal(result.status, 0, result.stderr);

		write('.claude/notes.md', `[Broken](../${SPEC}#missing)\n`);
		result = run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /\.claude\/notes\.md:1.*no such heading/);
		assert.doesNotMatch(result.stderr, /worktrees\/other/);
	});
}
