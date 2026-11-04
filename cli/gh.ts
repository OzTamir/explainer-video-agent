/**
 * Read-only pull request access through the GitHub CLI, for the local agent.
 * Uses whatever `gh auth login` holds on this machine; no App, no token in
 * this process's environment. Same endpoints and mapping as the App client
 * (src/integrations/github.ts), so both agents see identical data.
 *
 * Node-only (child processes): never import this from src/.
 */
import { execFile } from 'node:child_process';
import type { PullRequestSource } from '../src/explainer/core.ts';
import {
	type PullRequestFile,
	type PullRequestRef,
	type RawCommit,
	type RawFile,
	type RawPullRequest,
	toCommit,
	toFile,
	toPullRequest,
} from '../src/integrations/github.ts';

function gh(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`gh ${args.join(' ')} failed: ${(stderr || error.message).trim().slice(0, 500)}`));
			else resolve(stdout);
		});
	});
}

async function api<T>(path: string): Promise<T> {
	return JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', path])) as T;
}

/** Every page of a list endpoint; `--slurp` wraps the pages in one outer array. */
async function apiList<T>(path: string): Promise<T[]> {
	const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', path])) as T[][];
	return pages.flat();
}

export function ghSource(ref: PullRequestRef): PullRequestSource {
	const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
	let files: Promise<PullRequestFile[]> | undefined;
	return {
		getPullRequest: async () => toPullRequest(await api<RawPullRequest>(base)),
		// Fetched once per agent turn and shared by pull_request and pull_request_patches.
		listFiles: () =>
			(files ??= apiList<RawFile>(`${base}/files?per_page=100`).then(
				(all) => all.map(toFile),
				(error: unknown) => {
					files = undefined;
					throw error;
				},
			)),
		listCommits: async () => (await apiList<RawCommit>(`${base}/commits?per_page=100`)).map(toCommit),
	};
}
