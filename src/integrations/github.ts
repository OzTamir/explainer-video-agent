/**
 * GitHub REST client on `fetch`, authenticated as a GitHub App installation.
 * Reads pull requests and writes issue comments and reactions; nothing else.
 *
 * Credentials: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM GitHub
 * generates for the App). Per installation the client mints a one-hour
 * installation token with a signed App JWT and caches it in the isolate.
 * The App needs, on the repositories it is installed on: Pull requests: read,
 * Issues: write. Comments appear as `<app name>[bot]`.
 */
import { requireEnv } from './env.ts';

const API = 'https://api.github.com';

export type PullRequestRef = { owner: string; repo: string; number: number };

export type PullRequest = {
	number: number;
	title: string;
	body: string;
	author: string;
	state: 'open' | 'closed';
	draft: boolean;
	merged: boolean;
	baseRef: string;
	headRef: string;
	headSha: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	commits: number;
	url: string;
};

export type PullRequestFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	/** Unified-diff hunks for this file; absent for binary files and very large diffs. */
	patch?: string;
};

export type PullRequestCommit = {
	sha: string;
	subject: string;
	authorLogin: string | null;
	authorName: string | null;
};

export type IssueComment = { id: number; url: string };

export class GitHubClient {
	readonly #installationId: number;

	/** A client acting as the App's installation on the repository the webhook came from. */
	constructor(installationId: number) {
		if (!Number.isInteger(installationId) || installationId <= 0) {
			throw new Error('A GitHub App installation id is required.');
		}
		this.#installationId = installationId;
	}

	async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
		const pr = await this.#json<RawPullRequest>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
		return {
			number: pr.number,
			title: pr.title,
			body: pr.body ?? '',
			author: pr.user?.login ?? 'unknown',
			state: pr.state,
			draft: Boolean(pr.draft),
			merged: Boolean(pr.merged),
			baseRef: pr.base.ref,
			headRef: pr.head.ref,
			headSha: pr.head.sha,
			additions: pr.additions,
			deletions: pr.deletions,
			changedFiles: pr.changed_files,
			commits: pr.commits,
			url: pr.html_url,
		};
	}

	/** Every changed file with its patch. GitHub pages at 100 files; walks every page (capped at 10). */
	async listPullRequestFiles(ref: PullRequestRef): Promise<PullRequestFile[]> {
		const files: PullRequestFile[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = await this.#json<RawFile[]>(
				`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100&page=${page}`,
			);
			for (const f of batch) {
				files.push({
					filename: f.filename,
					status: f.status,
					additions: f.additions,
					deletions: f.deletions,
					...(f.patch ? { patch: f.patch } : {}),
				});
			}
			if (batch.length < 100) break;
		}
		return files;
	}

	async listPullRequestCommits(ref: PullRequestRef): Promise<PullRequestCommit[]> {
		const commits: PullRequestCommit[] = [];
		for (let page = 1; page <= 3; page++) {
			const batch = await this.#json<RawCommit[]>(
				`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100&page=${page}`,
			);
			for (const c of batch) {
				commits.push({
					sha: c.sha,
					subject: (c.commit.message ?? '').split('\n')[0] ?? '',
					authorLogin: c.author?.login ?? null,
					authorName: c.commit.author?.name ?? null,
				});
			}
			if (batch.length < 100) break;
		}
		return commits;
	}

	async createIssueComment(ref: PullRequestRef, body: string): Promise<IssueComment> {
		const c = await this.#json<RawComment>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, {
			method: 'POST',
			body: JSON.stringify({ body }),
		});
		return { id: c.id, url: c.html_url };
	}

	async updateIssueComment(
		ref: Pick<PullRequestRef, 'owner' | 'repo'>,
		commentId: number,
		body: string,
	): Promise<IssueComment> {
		const c = await this.#json<RawComment>(`/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`, {
			method: 'PATCH',
			body: JSON.stringify({ body }),
		});
		return { id: c.id, url: c.html_url };
	}

	/** Reacts to an issue or PR comment (for example `eyes` to acknowledge a command). */
	async reactToIssueComment(
		ref: Pick<PullRequestRef, 'owner' | 'repo'>,
		commentId: number,
		content: 'eyes' | '+1' | '-1' | 'rocket' | 'confused' | 'heart' | 'hooray' | 'laugh',
	): Promise<void> {
		await this.#json(`/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}/reactions`, {
			method: 'POST',
			body: JSON.stringify({ content }),
		});
	}

	async #json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
		const token = await installationToken(this.#installationId);
		const response = await fetch(`${API}${path}`, {
			...init,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				'user-agent': 'pr-explainer-agent',
				'x-github-api-version': '2022-11-28',
				...(init.headers ?? {}),
			},
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`GitHub ${init.method ?? 'GET'} ${path} failed: ${response.status} ${text.slice(0, 300)}`,
			);
		}
		return (await response.json()) as T;
	}
}

// ---------------------------------------------------------------------------
// GitHub App authentication: App JWT (RS256, 10 minutes) → installation token
// (1 hour), cached per installation for the life of the isolate.
// ---------------------------------------------------------------------------

type CachedToken = { token: string; expiresAt: number };
const tokens = new Map<number, CachedToken>();

async function installationToken(installationId: number): Promise<string> {
	const cached = tokens.get(installationId);
	if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

	const jwt = await appJwt();
	const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${jwt}`,
			'user-agent': 'pr-explainer-agent',
			'x-github-api-version': '2022-11-28',
		},
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(
			`GitHub App installation token failed for installation ${installationId}: ${response.status} ${text.slice(0, 300)}. Is the App installed on this repository and GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY correct?`,
		);
	}
	const data = (await response.json()) as { token: string; expires_at: string };
	tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
	return data.token;
}

let signingKey: Promise<CryptoKey> | undefined;

async function appJwt(): Promise<string> {
	const appId = requireEnv('GITHUB_APP_ID');
	signingKey ??= importPrivateKey(requireEnv('GITHUB_APP_PRIVATE_KEY'));
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
	// iat 60 s in the past tolerates clock drift between the Worker and GitHub.
	const payload = base64url(
		new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
	);
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		await signingKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * GitHub issues App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports
 * PKCS#8 only, so a PKCS#1 body is wrapped in the PKCS#8 envelope here. A key
 * already in PKCS#8 ("BEGIN PRIVATE KEY") is imported as is.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const normalized = pem.replace(/\\n/g, '\n').trim();
	const match = normalized.match(
		/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/,
	);
	if (!match) throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key.');
	const der = base64decode(match[2]!.replace(/\s+/g, ''));
	const pkcs8 = match[1] ? wrapPkcs1InPkcs8(der) : der;
	return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
		'sign',
	]);
}

/** PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { PKCS#1 } }. */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
	const algorithm = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	]);
	const version = new Uint8Array([0x02, 0x01, 0x00]);
	const octetString = concat(derHeader(0x04, pkcs1.length), pkcs1);
	const body = concat(version, algorithm, octetString);
	return concat(derHeader(0x30, body.length), body);
}

function derHeader(tag: number, length: number): Uint8Array {
	if (length < 0x80) return new Uint8Array([tag, length]);
	const bytes: number[] = [];
	for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
	return new Uint8Array([tag, 0x80 | bytes.length, ...bytes]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function base64decode(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type RawPullRequest = {
	number: number;
	title: string;
	body: string | null;
	user: { login: string } | null;
	state: 'open' | 'closed';
	draft?: boolean;
	merged?: boolean;
	base: { ref: string };
	head: { ref: string; sha: string };
	additions: number;
	deletions: number;
	changed_files: number;
	commits: number;
	html_url: string;
};

type RawFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };

type RawCommit = {
	sha: string;
	commit: { message?: string; author?: { name?: string } | null };
	author: { login: string } | null;
};

type RawComment = { id: number; html_url: string };
