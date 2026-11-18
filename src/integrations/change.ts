/**
 * The provider-neutral shape the agent works with: one change (a GitHub pull
 * request or a GitLab merge request) and the small client both providers
 * satisfy. The reference always comes from a verified webhook, never the model.
 */
import { GitHubClient, type PullRequestRef } from './github.ts';
import { GitLabClient, type MergeRequestRef } from './gitlab.ts';

export type Provider = 'github' | 'gitlab';

/** A pull request plus the App installation to act through, or a merge request. */
export type ChangeRef = (PullRequestRef & { provider: 'github'; installationId: number }) | MergeRequestRef;

export type Change = {
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

export type ChangeFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	/** Unified-diff hunks for this file; absent for binary files and very large diffs. */
	patch?: string;
};

export type ChangeCommit = {
	sha: string;
	subject: string;
	authorLogin: string | null;
	authorName: string | null;
};

export type ChangeComment = { id: number; url: string };

export type ChangeClient = {
	getChange(): Promise<Change>;
	listFiles(): Promise<ChangeFile[]>;
	listCommits(): Promise<ChangeCommit[]>;
	createComment(body: string): Promise<ChangeComment>;
	updateComment(commentId: number, body: string): Promise<ChangeComment>;
};

export type Wording = { host: string; noun: string; short: string; label: string };

/** How each provider names a change; `label` is how people refer to this one. */
export function wording(ref: ChangeRef): Wording {
	return ref.provider === 'gitlab'
		? { host: 'GitLab', noun: 'merge request', short: 'MR', label: `${ref.projectPath}!${ref.number}` }
		: { host: 'GitHub', noun: 'pull request', short: 'PR', label: `${ref.owner}/${ref.repo}#${ref.number}` };
}

export function changeNoun(provider: Provider): string {
	return provider === 'gitlab' ? 'merge request' : 'pull request';
}

/** The client for a change, bound to it: callers pass content, never a destination. */
export function changeClient(ref: ChangeRef): ChangeClient {
	if (ref.provider === 'gitlab') return new GitLabClient(ref);
	const github = new GitHubClient(ref.installationId);
	return {
		getChange: () => github.getPullRequest(ref),
		listFiles: () => github.listPullRequestFiles(ref),
		listCommits: () => github.listPullRequestCommits(ref),
		createComment: (body) => github.createIssueComment(ref, body),
		updateComment: (commentId, body) => github.updateIssueComment(ref, commentId, body),
	};
}
