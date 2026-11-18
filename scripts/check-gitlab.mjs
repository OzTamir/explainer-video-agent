// Offline checks for the GitLab port. No dependencies, no network:
//   node scripts/check-gitlab.mjs
// Needs Node 22.18+ (it imports the TypeScript sources directly).
import assert from 'node:assert/strict';
import { EXPLAIN_COMMAND, parseExplainCommand } from '../src/channels/command.ts';
import { parseGitLabEvent, projectAllowed, verifyToken } from '../src/channels/gitlab-events.ts';
import { changeClient, wording } from '../src/integrations/change.ts';
import { GitLabClient, countLines } from '../src/integrations/gitlab.ts';

let passed = 0;
async function check(name, fn) {
	await fn();
	passed++;
	console.log(`ok  ${name}`);
}

const project = { id: 42, path_with_namespace: 'acme/tools/cli' };
const note = (attrs = {}, extra = {}) => ({
	object_kind: 'note',
	user: { id: 7, username: 'dana' },
	project,
	object_attributes: {
		id: 900,
		note: '/explain-vid focus on the migration',
		noteable_type: 'MergeRequest',
		author_id: 7,
		system: false,
		action: 'create',
		url: 'https://gitlab.example/acme/tools/cli/-/merge_requests/12#note_900',
		...attrs,
	},
	merge_request: { iid: 12, title: 'Add migration' },
	...extra,
});

await check('webhook token: only the exact secret passes', async () => {
	assert.equal(await verifyToken('placeholder-secret', 'placeholder-secret'), true);
	assert.equal(await verifyToken('placeholder-secreT', 'placeholder-secret'), false);
	assert.equal(await verifyToken('placeholder', 'placeholder-secret'), false);
	assert.equal(await verifyToken('', 'placeholder-secret'), false);
	assert.equal(await verifyToken(undefined, 'placeholder-secret'), false);
	assert.equal(await verifyToken(null, 'placeholder-secret'), false);
	assert.equal(await verifyToken('anything', undefined), false);
	assert.equal(await verifyToken('', ''), false);
});

await check('command: same rules as GitHub', () => {
	assert.equal(EXPLAIN_COMMAND, '/explain-vid');
	assert.deepEqual(parseExplainCommand('/explain-vid'), { request: '' });
	assert.deepEqual(parseExplainCommand('  /explain-vid  \n'), { request: '' });
	assert.deepEqual(parseExplainCommand('/explain-vid focus on X'), { request: 'focus on X' });
	assert.deepEqual(parseExplainCommand('/explain-vid\nfor support'), { request: 'for support' });
	assert.equal(parseExplainCommand('/explain-video'), null);
	assert.equal(parseExplainCommand('/explain-vids'), null);
	assert.equal(parseExplainCommand('please /explain-vid'), null);
	assert.equal(parseExplainCommand(''), null);
});

await check('note hook: the command on a merge request becomes an explain event', () => {
	assert.deepEqual(parseGitLabEvent('Note Hook', note()), {
		kind: 'explain',
		projectId: 42,
		projectPath: 'acme/tools/cli',
		number: 12,
		title: 'Add migration',
		noteId: 900,
		noteUrl: 'https://gitlab.example/acme/tools/cli/-/merge_requests/12#note_900',
		authorId: 7,
		authorUsername: 'dana',
		request: 'focus on the migration',
	});
	// Older GitLab versions send no action field.
	assert.equal(parseGitLabEvent('Note Hook', note({ action: undefined })).kind, 'explain');
});

await check('note hook: everything else is ignored', () => {
	const ignored = (payload, header = 'Note Hook') => {
		const event = parseGitLabEvent(header, payload);
		assert.equal(event.kind, 'ignored', JSON.stringify(event));
	};
	ignored(note({ noteable_type: 'Issue' }));
	ignored(note({ noteable_type: 'Commit' }));
	ignored(note({ system: true }));
	ignored(note({ action: 'update' }));
	ignored(note({ note: 'looks good' }));
	ignored(note({ note: '/explain-video' }));
	ignored(note({ note: 42 }));
	ignored(note({ id: undefined }));
	ignored(note({}, { merge_request: undefined }));
	ignored(note({}, { project: undefined }));
	ignored(note({}, { project: { id: '42', path_with_namespace: 'acme/tools/cli' } }));
	ignored(note(), 'Push Hook');
	ignored(note(), null);
	ignored(null);
	ignored('text');
	ignored([]);
});

await check('merge request hook: close and merge clean up, the rest is ignored', () => {
	const mr = (action) => ({ project, object_attributes: { iid: 12, action } });
	const closed = { kind: 'closed', projectId: 42, projectPath: 'acme/tools/cli', number: 12 };
	assert.deepEqual(parseGitLabEvent('Merge Request Hook', mr('close')), closed);
	assert.deepEqual(parseGitLabEvent('Merge Request Hook', mr('merge')), closed);
	for (const action of ['open', 'reopen', 'update', 'approved', undefined]) {
		assert.equal(parseGitLabEvent('Merge Request Hook', mr(action)).kind, 'ignored');
	}
	assert.equal(parseGitLabEvent('Merge Request Hook', { project, object_attributes: { action: 'close' } }).kind, 'ignored');
});

await check('allowlist: exact project or group prefix', () => {
	assert.equal(projectAllowed('acme/api', undefined), true);
	assert.equal(projectAllowed('acme/api', ''), true);
	assert.equal(projectAllowed('acme/api', ' , '), true);
	assert.equal(projectAllowed('acme/api', 'acme/api'), true);
	assert.equal(projectAllowed('Acme/API', 'other/x, acme/api'), true);
	assert.equal(projectAllowed('acme/tools/cli', 'acme'), true);
	assert.equal(projectAllowed('acme/tools/cli', 'acme/tools/'), true);
	assert.equal(projectAllowed('acme-labs/api', 'acme'), false);
	assert.equal(projectAllowed('acme/api2', 'acme/api'), false);
	assert.equal(projectAllowed('acme', 'acme/api'), false);
});

await check('diff line counts skip headers and count hunks', () => {
	assert.deepEqual(countLines('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n'), { additions: 2, deletions: 1 });
	assert.deepEqual(countLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'), { additions: 1, deletions: 1 });
	assert.deepEqual(countLines(''), { additions: 0, deletions: 0 });
});

// --- The client against a fake GitLab. Nothing leaves this process. ---

const calls = [];
const json = (body, headers = {}) =>
	new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const routes = {
	'GET /projects/42/merge_requests/12': () =>
		json({
			iid: 12,
			title: 'Add migration',
			description: null,
			author: { username: 'dana' },
			state: 'opened',
			draft: true,
			target_branch: 'main',
			source_branch: 'feat/migration',
			sha: 'abc123',
			web_url: 'https://gitlab.example/acme/tools/cli/-/merge_requests/12',
		}),
	'GET /projects/42/merge_requests/12/diffs?per_page=100&page=1': () =>
		json(
			[
				{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1,2 @@\n-x\n+y\n+z\n' },
				{ old_path: 'new.ts', new_path: 'new.ts', new_file: true, diff: '@@ -0,0 +1 @@\n+hello\n' },
			],
			{ 'x-next-page': '2' },
		),
	'GET /projects/42/merge_requests/12/diffs?per_page=100&page=2': () =>
		json(
			[
				{ old_path: 'logo.png', new_path: 'logo.png', diff: '' },
				{ old_path: 'big.sql', new_path: 'big.sql', too_large: true, diff: '' },
				{ old_path: 'old.ts', new_path: 'moved.ts', renamed_file: true, diff: '' },
				{ old_path: 'gone.ts', new_path: 'gone.ts', deleted_file: true, diff: '@@ -1 +0,0 @@\n-bye\n' },
			],
			{ 'x-next-page': '' },
		),
	'GET /projects/42/merge_requests/12/commits?per_page=100&page=1': () =>
		json([{ id: 'abc123def', title: 'Add migration', message: 'Add migration\n\nbody', author_name: 'Dana' }]),
	'POST /projects/42/merge_requests/12/notes': () => json({ id: 901 }),
	'PUT /projects/42/merge_requests/12/notes/901': () => json({ id: 901 }),
	'POST /projects/42/merge_requests/12/notes/900/award_emoji': () => json({ id: 1, name: 'eyes' }),
	'GET /projects/42/members/all/7': () => json({ id: 7, access_level: 30, state: 'active' }),
	'GET /projects/42/members/all/8': () => json({ id: 8, access_level: 20, state: 'active' }),
	'GET /projects/42/members/all/9': () => new Response('{"message":"404 Not found"}', { status: 404 }),
	'GET /projects/42/members/all/10': () => json({ id: 10, access_level: 40, state: 'blocked' }),
};
globalThis.fetch = async (url, init = {}) => {
	const prefix = 'https://gitlab.example/api/v4';
	assert.ok(String(url).startsWith(prefix), `unexpected host: ${url}`);
	const key = `${init.method ?? 'GET'} ${String(url).slice(prefix.length)}`;
	calls.push({ key, headers: init.headers, body: init.body });
	const route = routes[key];
	return route ? route() : new Response('no such route', { status: 500 });
};
process.env.GITLAB_BASE_URL = 'https://gitlab.example/';
process.env.GITLAB_TOKEN = 'placeholder-token';

const ref = { provider: 'gitlab', projectId: 42, projectPath: 'acme/tools/cli', number: 12 };

await check('client: reads a merge request in the shape the agent expects', async () => {
	const client = new GitLabClient(ref);
	const [change, files, commits] = await Promise.all([client.getChange(), client.listFiles(), client.listCommits()]);
	assert.deepEqual(change, {
		number: 12,
		title: 'Add migration',
		body: '',
		author: 'dana',
		state: 'open',
		draft: true,
		merged: false,
		baseRef: 'main',
		headRef: 'feat/migration',
		headSha: 'abc123',
		additions: 3,
		deletions: 2,
		changedFiles: 6,
		commits: 1,
		url: 'https://gitlab.example/acme/tools/cli/-/merge_requests/12',
	});
	assert.deepEqual(
		files.map((f) => [f.filename, f.status, f.additions, f.deletions, 'patch' in f]),
		[
			['a.ts', 'modified', 2, 1, true],
			['new.ts', 'added', 1, 0, true],
			['logo.png', 'modified', 0, 0, false],
			['big.sql', 'modified', 0, 0, false],
			['moved.ts', 'renamed', 0, 0, false],
			['gone.ts', 'removed', 0, 1, true],
		],
	);
	assert.deepEqual(commits, [{ sha: 'abc123def', subject: 'Add migration', authorLogin: null, authorName: 'Dana' }]);
	// The diffs and commits are fetched once even though getChange needs them too.
	assert.equal(calls.filter((c) => c.key.includes('/diffs')).length, 2);
	assert.equal(calls.filter((c) => c.key.includes('/commits')).length, 1);
	assert.ok(calls.every((c) => c.headers['private-token'] === 'placeholder-token'));
});

await check('client: writes notes and the reaction on the bound merge request only', async () => {
	const client = changeClient(ref);
	const created = await client.createComment('hello');
	assert.deepEqual(created, {
		id: 901,
		url: 'https://gitlab.example/acme/tools/cli/-/merge_requests/12#note_901',
	});
	assert.equal((await client.updateComment(901, 'edited')).id, 901);
	await new GitLabClient(ref).reactToComment(900, 'eyes');
	const writes = calls.filter((c) => !c.key.startsWith('GET')).map((c) => [c.key, c.body]);
	assert.deepEqual(writes, [
		['POST /projects/42/merge_requests/12/notes', '{"body":"hello"}'],
		['PUT /projects/42/merge_requests/12/notes/901', '{"body":"edited"}'],
		['POST /projects/42/merge_requests/12/notes/900/award_emoji', '{"name":"eyes"}'],
	]);
});

await check('client: access level decides who may trigger', async () => {
	const client = new GitLabClient(ref);
	assert.equal(await client.accessLevel(7), 30);
	assert.equal(await client.accessLevel(8), 20);
	assert.equal(await client.accessLevel(9), 0);
	assert.equal(await client.accessLevel(10), 0);
	await assert.rejects(client.accessLevel(11), /GitLab GET project member failed: 500/);
});

await check('client: a missing token fails on use, not on import', async () => {
	delete process.env.GITLAB_TOKEN;
	await assert.rejects(new GitLabClient(ref).listCommits(), /GITLAB_TOKEN/);
	assert.throws(() => new GitLabClient({ ...ref, projectId: 0 }), /project id/);
});

await check('wording: merge request on GitLab, pull request on GitHub', () => {
	assert.deepEqual(wording(ref), { host: 'GitLab', noun: 'merge request', short: 'MR', label: 'acme/tools/cli!12' });
	const github = { provider: 'github', owner: 'acme', repo: 'api', number: 5, installationId: 1 };
	assert.deepEqual(wording(github), { host: 'GitHub', noun: 'pull request', short: 'PR', label: 'acme/api#5' });
});

console.log(`\n${passed} checks passed`);
