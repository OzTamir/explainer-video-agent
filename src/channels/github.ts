import { createGitHubChannel } from '@flue/github';
import { dispatch } from '@flue/runtime';
import { PrExplainer, type PrExplainerInitialData, renderExplainerComment } from '../agents/pr-explainer.ts';
import { optionalEnv, requireEnv } from '../integrations/env.ts';
import { deletePrefix, listRuns, pullRequestPrefix } from '../integrations/explainer-store.ts';
import { GitHubClient, type PullRequestRef } from '../integrations/github.ts';

/** The slash command, as the first token of a pull-request comment. */
export const EXPLAIN_COMMAND = '/explain-vid';

/**
 * Comment authors allowed to trigger a render. GitHub's `author_association`
 * is computed per repository, so this holds for forks of the repo too: a
 * stranger commenting on a public PR is `NONE` or `CONTRIBUTOR`.
 */
const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Optional repository allowlist (`owner/repo`, comma-separated). Unset means
 * every repository the webhook is installed on, which is the right default for
 * a single-repo or single-org installation.
 */
function repositoryAllowed(fullName: string): boolean {
	const allow = optionalEnv('GITHUB_ALLOWED_REPOS');
	return (
		!allow ||
		allow
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.includes(fullName.toLowerCase())
	);
}

/** Built on first request: the module is evaluated at upload, before secrets exist. */
type GitHubChannel = ReturnType<typeof createGitHubChannel>;
let built: GitHubChannel | undefined;

export function githubChannel(): GitHubChannel {
	return (built ??= buildChannel());
}

/** Handler for `app.all('/channels/github/*', mount(githubHandler))`; the channel's own path is `/webhook`. */
export async function githubHandler(request: Request, ...args: unknown[]): Promise<Response> {
	if (!optionalEnv('GITHUB_WEBHOOK_SECRET')) {
		return new Response('GITHUB_WEBHOOK_SECRET is not configured', { status: 503 });
	}
	return githubChannel()
		.route()
		.fetch(request, ...(args as [object, undefined]));
}

function buildChannel(): GitHubChannel {
	const channel = createGitHubChannel({
		webhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),

		// Path: /channels/github/webhook — the GitHub App's webhook, subscribed to
		// "Issue comment" (the command) and "Pull request" (cleanup on close).
		async webhook({ c, delivery }) {
			if (delivery.name === 'pull_request' && delivery.payload.action === 'closed') {
				const { repository, pull_request, installation } = delivery.payload;
				if (!installation?.id) return undefined;
				const ref = { owner: repository.owner.login, repo: repository.name, number: pull_request.number };
				// Best effort, after the acknowledgement: delete the PR's videos and say so in the comments.
				c.executionCtx.waitUntil(removePullRequestVideos(ref, installation.id).catch(() => undefined));
				return undefined;
			}

			if (delivery.name !== 'issue_comment' || delivery.payload.action !== 'created') return undefined;
			const { repository, issue, comment, sender, installation } = delivery.payload;

			// Only pull requests, only the slash command, only people with write access, never bots.
			if (!issue.pull_request) return undefined;
			const body = comment.body.trim();
			if (!isExplainCommand(body)) return undefined;
			if (comment.user?.type === 'Bot') return undefined;
			if (!ALLOWED_ASSOCIATIONS.has(comment.author_association)) return undefined;
			if (!repositoryAllowed(repository.full_name)) return undefined;
			// An App webhook always names the installation; without it there is no identity to act as.
			if (!installation?.id) return undefined;

			const ref = { owner: repository.owner.login, repo: repository.name, issueNumber: issue.number };
			const request = body.slice(EXPLAIN_COMMAND.length).trim();

			await dispatch(PrExplainer, {
				id: channel.instanceId(ref),
				// GitHub redeliveries keep their delivery id, so a manual redelivery never runs twice.
				idempotencyKey: delivery.deliveryId,
				initialData: {
					owner: ref.owner,
					repo: ref.repo,
					number: ref.issueNumber,
					installationId: installation.id,
					title: issue.title,
					openedBy: issue.user?.login ?? 'unknown',
				} satisfies PrExplainerInitialData,
				message: {
					kind: 'signal',
					type: 'github.explain_vid',
					body: request
						? `@${sender.login} asked for an explainer video of this pull request with a note: ${request}`
						: `@${sender.login} asked for an explainer video of this pull request.`,
					attributes: {
						deliveryId: delivery.deliveryId,
						commentId: String(comment.id),
						commentUrl: comment.html_url,
						sender: sender.login,
						request,
					},
				},
			});

			// Instant feedback on the command while the agent and its container start.
			// Best effort, outside the acknowledgement path.
			c.executionCtx.waitUntil(
				new GitHubClient(installation.id).reactToIssueComment(ref, comment.id, 'eyes').catch(() => undefined),
			);
			return undefined;
		},
	});
	return channel;
}

/** `/explain-vid` alone, or followed by whitespace and a note. `/explain-video` is not it. */
function isExplainCommand(body: string): boolean {
	return body === EXPLAIN_COMMAND || /^\/explain-vid\s/.test(body);
}

/**
 * A closed pull request keeps its explainer comments but loses the videos:
 * every run's objects are deleted and its comment is rewritten to say so.
 * No model turn is involved; the comment's text comes from the run's meta record.
 */
async function removePullRequestVideos(ref: PullRequestRef, installationId: number): Promise<void> {
	const prefix = pullRequestPrefix(ref);
	const runs = await listRuns(prefix);
	const github = new GitHubClient(installationId);
	for (const { meta } of runs) {
		const body = renderExplainerComment({
			number: ref.number,
			requestedBy: meta.requestedBy,
			summary: meta.summary,
			covers: meta.covers,
			video: null,
		});
		await github.updateIssueComment(ref, meta.commentId, body).catch(() => undefined);
	}
	await deletePrefix(prefix);
}
