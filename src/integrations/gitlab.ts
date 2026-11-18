/**
 * GitLab REST client on `fetch`, bound to one merge request. Reads the merge
 * request, its diffs and commits, and writes notes and one award emoji;
 * nothing else.
 *
 * Credentials: `GITLAB_TOKEN`, sent as `PRIVATE-TOKEN`. Meant to be a group
 * access token with the Reporter role and the `api` scope (docs/gitlab.md).
 * Notes appear as the token's bot user. `GITLAB_BASE_URL` picks the instance
 * (default https://gitlab.com).
 */
import type { Change, ChangeClient, ChangeComment, ChangeCommit, ChangeFile } from './change.ts';
import { optionalEnv, requireEnv } from './env.ts';

export type MergeRequestRef = {
	provider: 'gitlab';
	/** Numeric project id from the verified webhook; stable across renames. */
	projectId: number;
	/** `group/subgroup/project`, for links and wording only. */
	projectPath: string;
	/** The merge request iid (the number in `!12`). */
	number: number;
};

/** GitLab's numeric access level for the Developer role. */
export const DEVELOPER_ACCESS = 30;

const PER_PAGE = 100;

export function gitlabBaseUrl(): string {
	return (optionalEnv('GITLAB_BASE_URL') ?? 'https://gitlab.com').replace(/\/+$/, '');
}

export class GitLabClient implements ChangeClient {
	readonly #ref: MergeRequestRef;
	// One client serves one tool call; the lists are fetched once and shared.
	#files: Promise<ChangeFile[]> | undefined;
	#commits: Promise<ChangeCommit[]> | undefined;

	constructor(ref: MergeRequestRef) {
		if (!Number.isInteger(ref.projectId) || ref.projectId <= 0) {
			throw new Error('A GitLab project id is required.');
		}
		this.#ref = ref;
	}

	get #mr(): string {
		return `/projects/${this.#ref.projectId}/merge_requests/${this.#ref.number}`;
	}

	/** GitLab does not report line counts on a merge request, so they are summed from the diffs. */
	async getChange(): Promise<Change> {
		const [mr, files, commits] = await Promise.all([
			gitlabJson<RawMergeRequest>(this.#mr),
			this.listFiles(),
			this.listCommits(),
		]);
		return {
			number: mr.iid,
			title: mr.title,
			body: mr.description ?? '',
			author: mr.author?.username ?? 'unknown',
			state: mr.state === 'opened' || mr.state === 'locked' ? 'open' : 'closed',
			draft: Boolean(mr.draft),
			merged: mr.state === 'merged',
			baseRef: mr.target_branch,
			headRef: mr.source_branch,
			headSha: mr.sha ?? '',
			additions: files.reduce((n, f) => n + f.additions, 0),
			deletions: files.reduce((n, f) => n + f.deletions, 0),
			changedFiles: files.length,
			commits: commits.length,
			url: mr.web_url,
		};
	}

	/** Every changed file with its diff. Pages at 100 files; walks every page (capped at 10, like GitHub). */
	listFiles(): Promise<ChangeFile[]> {
		return (this.#files ??= this.#pages<RawDiff>(`${this.#mr}/diffs`, 10).then((raw) => raw.map(toChangeFile)));
	}

	/** GitLab commits carry a name and an email, never a username. */
	listCommits(): Promise<ChangeCommit[]> {
		return (this.#commits ??= this.#pages<RawCommit>(`${this.#mr}/commits`, 3).then((raw) =>
			raw.map((c) => ({
				sha: c.id,
				subject: c.title ?? (c.message ?? '').split('\n')[0] ?? '',
				authorLogin: null,
				authorName: c.author_name ?? null,
			})),
		));
	}

	async createComment(body: string): Promise<ChangeComment> {
		const note = await gitlabJson<RawNote>(`${this.#mr}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
		return { id: note.id, url: this.#noteUrl(note.id) };
	}

	async updateComment(noteId: number, body: string): Promise<ChangeComment> {
		const note = await gitlabJson<RawNote>(`${this.#mr}/notes/${noteId}`, {
			method: 'PUT',
			body: JSON.stringify({ body }),
		});
		return { id: note.id, url: this.#noteUrl(note.id) };
	}

	/** Award emoji on a note (for example `eyes` to acknowledge a command). */
	async reactToComment(noteId: number, name: string): Promise<void> {
		await gitlabJson(`${this.#mr}/notes/${noteId}/award_emoji`, { method: 'POST', body: JSON.stringify({ name }) });
	}

	/** The user's effective access level on the project (inherited and invited memberships included); 0 for none. */
	async accessLevel(userId: number): Promise<number> {
		const response = await gitlabFetch(`/projects/${this.#ref.projectId}/members/all/${userId}`);
		if (response.status === 404) return 0;
		if (!response.ok) throw await failure('GET', 'project member', response);
		const member = (await response.json()) as { access_level?: number; state?: string };
		if (member.state && member.state !== 'active') return 0;
		return member.access_level ?? 0;
	}

	#noteUrl(noteId: number): string {
		return `${gitlabBaseUrl()}/${this.#ref.projectPath}/-/merge_requests/${this.#ref.number}#note_${noteId}`;
	}

	async #pages<T>(path: string, maxPages: number): Promise<T[]> {
		const items: T[] = [];
		for (let page = 1; page <= maxPages; page++) {
			const response = await gitlabFetch(`${path}?per_page=${PER_PAGE}&page=${page}`);
			if (!response.ok) throw await failure('GET', path, response);
			const batch = (await response.json()) as T[];
			items.push(...batch);
			if (batch.length === 0 || !response.headers.get('x-next-page')) break;
		}
		return items;
	}
}

let tokenUser: Promise<{ id: number; username: string }> | undefined;

/** The user behind `GITLAB_TOKEN` (the group token's bot), cached for the life of the isolate. */
export function gitlabTokenUser(): Promise<{ id: number; username: string }> {
	tokenUser ??= gitlabJson<{ id: number; username: string }>('/user').catch((error) => {
		tokenUser = undefined;
		throw error;
	});
	return tokenUser;
}

/** Counts added and removed lines in one file's hunks; file headers before the first hunk are skipped. */
export function countLines(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('@@')) inHunk = true;
		else if (!inHunk) continue;
		else if (line.startsWith('+')) additions++;
		else if (line.startsWith('-')) deletions++;
	}
	return { additions, deletions };
}

function toChangeFile(d: RawDiff): ChangeFile {
	const status = d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified';
	// GitLab leaves `diff` empty for binary files and for diffs it collapsed or found too large.
	const patch = d.too_large || d.collapsed ? '' : (d.diff ?? '');
	return { filename: d.new_path, status, ...countLines(patch), ...(patch ? { patch } : {}) };
}

function gitlabFetch(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${gitlabBaseUrl()}/api/v4${path}`, {
		...init,
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'private-token': requireEnv('GITLAB_TOKEN'),
			'user-agent': 'pr-explainer-agent',
		},
	});
}

async function gitlabJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await gitlabFetch(path, init);
	if (!response.ok) throw await failure(init.method ?? 'GET', path, response);
	return (await response.json()) as T;
}

async function failure(method: string, path: string, response: Response): Promise<Error> {
	const text = await response.text().catch(() => '');
	return new Error(`GitLab ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
}

type RawMergeRequest = {
	iid: number;
	title: string;
	description: string | null;
	author: { username: string } | null;
	state: 'opened' | 'closed' | 'merged' | 'locked';
	draft?: boolean;
	target_branch: string;
	source_branch: string;
	sha: string | null;
	web_url: string;
};

type RawDiff = {
	old_path: string;
	new_path: string;
	diff?: string;
	new_file?: boolean;
	renamed_file?: boolean;
	deleted_file?: boolean;
	collapsed?: boolean;
	too_large?: boolean;
};

type RawCommit = { id: string; title?: string; message?: string; author_name?: string };

type RawNote = { id: number };
