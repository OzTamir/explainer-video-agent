/**
 * The pure half of the GitLab channel: token check, payload parsing and the
 * project allowlist. No framework imports, so `scripts/check-gitlab.mjs` can
 * run it with plain Node.
 */
import { parseExplainCommand } from './command.ts';

/**
 * Compares the `X-Gitlab-Token` header with the configured secret. Both are
 * hashed first, so the comparison takes the same time whatever the header's
 * length or content. An empty secret never matches.
 */
export async function verifyToken(header: string | null | undefined, secret: string | undefined): Promise<boolean> {
	if (!header || !secret) return false;
	const [a, b] = await Promise.all([digest(header), digest(secret)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export type GitLabProject = { projectId: number; projectPath: string };

export type GitLabEvent =
	| (GitLabProject & {
			kind: 'explain';
			number: number;
			title: string;
			noteId: number;
			noteUrl: string;
			authorId: number;
			authorUsername: string;
			request: string;
	  })
	| (GitLabProject & { kind: 'closed'; number: number })
	| { kind: 'ignored'; reason: string };

const ignored = (reason: string): GitLabEvent => ({ kind: 'ignored', reason });

/** Turns a verified delivery into the one thing to do about it. Unknown or malformed input is ignored. */
export function parseGitLabEvent(eventHeader: string | null | undefined, payload: unknown): GitLabEvent {
	const p = payload as RawPayload | null;
	if (!p || typeof p !== 'object') return ignored('not a JSON object');
	const projectId = p.project?.id;
	const projectPath = p.project?.path_with_namespace;
	if (!isId(projectId) || typeof projectPath !== 'string' || !projectPath) return ignored('no project');
	const project = { projectId, projectPath };

	if (eventHeader === 'Merge Request Hook') {
		const mr = p.object_attributes;
		if (mr?.action !== 'close' && mr?.action !== 'merge') return ignored('merge request not closed or merged');
		if (!isId(mr.iid)) return ignored('no merge request iid');
		return { kind: 'closed', ...project, number: mr.iid };
	}

	if (eventHeader !== 'Note Hook') return ignored('event not handled');
	const note = p.object_attributes;
	if (note?.noteable_type !== 'MergeRequest') return ignored('not a merge request comment');
	if (note.system) return ignored('system note');
	// Older GitLab sends no action; an edited comment must not start a second run.
	if (note.action && note.action !== 'create') return ignored('not a new comment');
	if (typeof note.note !== 'string') return ignored('no comment text');
	const command = parseExplainCommand(note.note);
	if (!command) return ignored('not the command');
	const number = p.merge_request?.iid;
	const authorId = note.author_id ?? p.user?.id;
	if (!isId(number) || !isId(note.id) || !isId(authorId)) return ignored('incomplete payload');
	return {
		kind: 'explain',
		...project,
		number,
		title: typeof p.merge_request?.title === 'string' ? p.merge_request.title : '',
		noteId: note.id,
		noteUrl: typeof note.url === 'string' ? note.url : '',
		authorId,
		authorUsername: typeof p.user?.username === 'string' ? p.user.username : 'unknown',
		request: command.request,
	};
}

/**
 * Optional project allowlist (comma-separated). An entry matches a project's
 * full path exactly, or every project under it when it names a group
 * (`acme` matches `acme/api` and `acme/tools/cli`, not `acme-labs/api`).
 * Unset or empty means every project the group webhook covers.
 */
export function projectAllowed(projectPath: string, allow: string | undefined): boolean {
	const entries = (allow ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase().replace(/^\/+|\/+$/g, ''))
		.filter(Boolean);
	if (entries.length === 0) return true;
	const path = projectPath.toLowerCase();
	return entries.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function isId(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

type RawPayload = {
	user?: { id?: number; username?: string };
	project?: { id?: number; path_with_namespace?: string };
	object_attributes?: {
		id?: number;
		iid?: number;
		note?: string;
		noteable_type?: string;
		author_id?: number;
		system?: boolean;
		action?: string;
		url?: string;
	};
	merge_request?: { iid?: number; title?: string };
};
