import { dispatch } from '@flue/runtime';
import type { Context } from 'hono';
import { PrExplainer, type PrExplainerInitialData, renderExplainerComment } from '../agents/pr-explainer.ts';
import { optionalEnv } from '../integrations/env.ts';
import { changePrefix, deletePrefix, listRuns } from '../integrations/explainer-store.ts';
import {
	DEVELOPER_ACCESS,
	GitLabClient,
	gitlabTokenUser,
	type MergeRequestRef,
} from '../integrations/gitlab.ts';
import { type GitLabEvent, parseGitLabEvent, projectAllowed, verifyToken } from './gitlab-events.ts';

type ExplainEvent = Extract<GitLabEvent, { kind: 'explain' }>;

/**
 * Hono handler for `POST /channels/gitlab/webhook`: a GitLab group webhook
 * with the triggers "Comments" (the command) and "Merge request events"
 * (cleanup on close or merge). Answers 200 with a short reason for everything
 * it ignores, so GitLab's delivery log explains itself and never disables the hook.
 */
export async function gitlabWebhook(c: Context): Promise<Response> {
	const secret = optionalEnv('GITLAB_WEBHOOK_SECRET');
	if (!secret) return c.text('GITLAB_WEBHOOK_SECRET is not configured', 503);
	if (!(await verifyToken(c.req.header('x-gitlab-token'), secret))) return c.text('Unauthorized', 401);

	const payload = await c.req.json().catch(() => null);
	const event = parseGitLabEvent(c.req.header('x-gitlab-event'), payload);
	if (event.kind === 'ignored') return c.text(`ignored: ${event.reason}`);

	const ref: MergeRequestRef = {
		provider: 'gitlab',
		projectId: event.projectId,
		projectPath: event.projectPath,
		number: event.number,
	};

	if (event.kind === 'closed') {
		// Best effort, after the acknowledgement: delete the MR's videos and say so in the notes.
		c.executionCtx.waitUntil(removeMergeRequestVideos(ref).catch(() => undefined));
		return c.text('cleanup started');
	}

	if (!projectAllowed(event.projectPath, optionalEnv('GITLAB_ALLOWED_PROJECTS'))) {
		return c.text('ignored: project not allowed');
	}
	const gitlab = new GitLabClient(ref);
	// Never answer the service's own notes, and only people with Developer access or more.
	if ((await gitlabTokenUser()).id === event.authorId) return c.text('ignored: own note');
	if ((await gitlab.accessLevel(event.authorId)) < DEVELOPER_ACCESS) {
		return c.text('ignored: author is not a Developer or above');
	}

	await dispatchExplain(ref, event);

	// Instant feedback on the command while the agent and its container start.
	c.executionCtx.waitUntil(gitlab.reactToComment(event.noteId, 'eyes').catch(() => undefined));
	return c.text('dispatched');
}

/** One conversation per merge request; the project id keeps it stable across renames. */
export function gitlabInstanceId(ref: MergeRequestRef): string {
	return `gitlab:v1:${ref.projectId}:${ref.number}`;
}

async function dispatchExplain(ref: MergeRequestRef, event: ExplainEvent): Promise<void> {
	// One comment is one run, so a retried or redelivered webhook never runs twice.
	const deliveryId = `note-${event.noteId}`;
	const sender = event.authorUsername;
	await dispatch(PrExplainer, {
		id: gitlabInstanceId(ref),
		idempotencyKey: deliveryId,
		initialData: {
			provider: 'gitlab',
			projectId: ref.projectId,
			projectPath: ref.projectPath,
			number: ref.number,
			title: event.title,
			openedBy: '',
		} satisfies PrExplainerInitialData,
		message: {
			kind: 'signal',
			type: 'gitlab.explain_vid',
			body: event.request
				? `@${sender} asked for an explainer video of this merge request with a note: ${event.request}`
				: `@${sender} asked for an explainer video of this merge request.`,
			attributes: {
				deliveryId,
				commentId: String(event.noteId),
				commentUrl: event.noteUrl,
				sender,
				request: event.request,
			},
		},
	});
}

/**
 * A closed or merged merge request keeps its explainer notes but loses the
 * videos, exactly like the GitHub channel does for a closed pull request.
 */
async function removeMergeRequestVideos(ref: MergeRequestRef): Promise<void> {
	const prefix = changePrefix(ref);
	const runs = await listRuns(prefix);
	const gitlab = new GitLabClient(ref);
	for (const { meta } of runs) {
		const body = renderExplainerComment({
			provider: 'gitlab',
			number: ref.number,
			requestedBy: meta.requestedBy,
			summary: meta.summary,
			covers: meta.covers,
			video: null,
		});
		await gitlab.updateComment(meta.commentId, body).catch(() => undefined);
	}
	await deletePrefix(prefix);
}
