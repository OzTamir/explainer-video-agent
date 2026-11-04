'use agent';
import { getSandbox, type Sandbox as SandboxDurableObject } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import {
	type AgentProps,
	defineTool,
	useDelivery,
	useInitialData,
	useModel,
	usePersistentState,
	useSandbox,
	useTool,
} from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import * as v from 'valibot';
import {
	COMPACTION_MODEL,
	MODEL,
	RENDER_DESCRIPTION,
	fmtDuration,
	generateNarration,
	prepareWorkspace,
	pullRequestFacts,
	pullRequestPatches,
	renderVideo,
	sharedSteps,
	workspaceParagraph,
	type PullRequestSource,
} from '../explainer/core.ts';
import {
	RETENTION_DAYS,
	objectUrl,
	pullRequestPrefix,
	putObject,
	putRunMeta,
} from '../integrations/explainer-store.ts';
import { GitHubClient, type PullRequestRef } from '../integrations/github.ts';

// ---------------------------------------------------------------------------
// One conversation per pull request, created by the GitHub channel when
// someone with write access comments `/explain-vid`.
// ---------------------------------------------------------------------------

export const initialData = v.object({
	owner: v.string(),
	repo: v.string(),
	number: v.number(),
	/** The GitHub App installation on this repository; the identity every API call acts as. */
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	title: v.string(),
	openedBy: v.string(),
});
export type PrExplainerInitialData = v.InferOutput<typeof initialData>;

/** The pull request plus the App installation to act through. */
type Target = PullRequestRef & { installationId: number };

/** Worker bindings the agent uses; declared in wrangler.jsonc. */
type Bindings = {
	Sandbox: DurableObjectNamespace<SandboxDurableObject>;
};
const bindings = () => env as unknown as Bindings;

/** Where the HyperFrames CLI, Chromium, FFmpeg and the HyperFrames skills live (see Dockerfile). */
const WORKSPACE = '/workspace';
/** The video project the agent scaffolds on every run. */
const PROJECT = `${WORKSPACE}/explainer`;
const OUTPUT_DIR = `${WORKSPACE}/out`;

const STAGES = ['reading', 'writing', 'narrating', 'building', 'rendering', 'done', 'failed'] as const;
type Stage = (typeof STAGES)[number];

const statusSchema = v.object({
	deliveryId: v.string(),
	commentId: v.number(),
	requestedBy: v.string(),
});

const publishedSchema = v.object({
	deliveryId: v.string(),
	videoUrl: v.string(),
	posterUrl: v.string(),
	durationSeconds: v.number(),
	sizeBytes: v.number(),
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function PrExplainer({ id }: AgentProps) {
	useModel(MODEL, {
		thinkingLevel: 'medium',
		compaction: { model: COMPACTION_MODEL },
	});

	const pr = useInitialData<PrExplainerInitialData>();
	const ref: Target = {
		owner: pr.owner,
		repo: pr.repo,
		number: pr.number,
		installationId: pr.installationId,
	};
	// A run is one webhook delivery of the command. The operator mount can also
	// prompt directly; those runs share one id so they keep editing one comment.
	const delivery = useDelivery();
	const attributes = delivery.kind === 'signal' ? (delivery.attributes ?? {}) : {};
	const run: RunInfo = {
		deliveryId: attributes.deliveryId || 'manual',
		requestedBy: attributes.sender || 'operator',
	};

	// The render environment: one container per pull request, keyed by the
	// conversation id. Its filesystem is scratch space; every run re-scaffolds.
	useSandbox(
		cloudflareSandbox(
			getSandbox(bindings().Sandbox, id, {
				// Cloudflare can take minutes to place the first instance of a new image
				// (the SDK's default is 30 s, which lost the first run after a deploy),
				// and the image is large (Chromium, fonts, FFmpeg), so the boot gets room too.
				// Both values are the SDK's maximums.
				containerTimeouts: { instanceGetTimeoutMS: 300_000, portReadyTimeoutMS: 600_000 },
			}),
			{ cwd: WORKSPACE },
		),
	);

	const [status, setStatus] = usePersistentState<v.InferOutput<typeof statusSchema> | null>('status', null);
	const [narrations, setNarrations] = usePersistentState<number>('narrations', 0);
	const [published, setPublished] = usePersistentState<v.InferOutput<typeof publishedSchema> | null>(
		'published',
		null,
	);

	const source = appSource(ref);
	useTool(pullRequestFacts(source));
	useTool(pullRequestPatches(source));
	useTool(setStatusComment(ref, run, status, setStatus));
	useTool(prepareWorkspace(WORKSPACE, PROJECT));
	useTool(
		generateNarration({
			project: PROJECT,
			narrations,
			setNarrations,
			maxNarrations: MAX_NARRATIONS,
			scope: 'pull request',
			giveUp: 'Call set_status with stage "failed" and stop.',
		}),
	);
	useTool(renderAndPublish(ref, run, setPublished));
	useTool(postExplainerComment(ref, run, status, setStatus, published));

	return instructions(pr, run);
}

PrExplainer.initialData = initialData;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function instructions(pr: PrExplainerInitialData, run: { requestedBy: string }): string {
	return `You turn one GitHub pull request into a short narrated explainer video and post it back on the pull request. This conversation is bound to ${pr.owner}/${pr.repo}#${pr.number} ("${pr.title}", opened by ${pr.openedBy}). Each <signal> you receive is one request for a video; the current one came from @${run.requestedBy}. If the signal carries a note, honor it (a focus area, a length, an audience); otherwise explain the change for an engineer who has not read the diff.

${workspaceParagraph('Your workspace is a Linux container with', 'rendering and publishing go through the render_and_publish tool')}

Do the steps in this order, and call set_status at every stage so the pull request shows progress:

${sharedSteps(PROJECT)}

5. rendering: call render_and_publish. It re-runs the check as a gate, renders at delivery quality, verifies the file, stores it and returns the video URL, a poster URL and the measured duration. A failed render returns the tail of the log; fix the cause and call it again.

6. done: call post_explainer_comment with the returned video URL, a one-sentence summary and two to four bullets of what the video covers. That call replaces the status comment with the final one.

If a step cannot be completed (missing credentials, a diff too large to read, a render that keeps failing), call set_status with stage "failed" and a one-line reason, then stop. Never post anything else to the pull request. Reply to the signal with a terse log of what you did; only the operator reads it.`;
}

// ---------------------------------------------------------------------------
// Pull request tools (read-only)
// ---------------------------------------------------------------------------

/** The pull request, read through the App installation. */
function appSource(ref: Target): PullRequestSource {
	const github = () => new GitHubClient(ref.installationId);
	return {
		getPullRequest: () => github().getPullRequest(ref),
		listFiles: () => github().listPullRequestFiles(ref),
		listCommits: () => github().listPullRequestCommits(ref),
	};
}

// ---------------------------------------------------------------------------
// Pull request comments. One comment per run: created at the first status,
// edited as stages pass, replaced by the final explainer comment at the end.
// ---------------------------------------------------------------------------

type Status = v.InferOutput<typeof statusSchema>;
type StatusSetter = (next: Status | null) => void;
type RunInfo = { deliveryId: string; requestedBy: string };

const STAGE_LINES: Record<Stage, string> = {
	reading: '👀 Reading the pull request',
	writing: '✍️ Writing the script',
	narrating: '🎙️ Recording the narration',
	building: '🎞️ Building the scenes',
	rendering: '🎬 Rendering the video',
	done: '✅ Done',
	failed: '❌ Could not finish',
};

function renderStatus(stage: Stage, note: string | undefined, requestedBy: string): string {
	const lines = [`**Explainer video** · ${STAGE_LINES[stage]}`];
	if (note) lines.push('', note);
	lines.push('', `<sub>Requested by @${requestedBy} with \`/explain-vid\`.</sub>`);
	return lines.join('\n');
}

/** Creates the run's comment on first use, edits it afterwards; a new run (new delivery) gets a new comment. */
async function upsertRunComment(
	ref: Target,
	run: RunInfo,
	status: Status | null,
	setStatus: StatusSetter,
	body: string,
): Promise<{ commentId: number; url: string }> {
	const github = new GitHubClient(ref.installationId);
	if (status && status.deliveryId === run.deliveryId) {
		const updated = await github.updateIssueComment(ref, status.commentId, body);
		return { commentId: updated.id, url: updated.url };
	}
	const created = await github.createIssueComment(ref, body);
	setStatus({ deliveryId: run.deliveryId, commentId: created.id, requestedBy: run.requestedBy });
	return { commentId: created.id, url: created.url };
}

function setStatusComment(ref: Target, run: RunInfo, status: Status | null, setStatus: StatusSetter) {
	return defineTool({
		name: 'set_status',
		description:
			'Show progress on the pull request: one comment, created at the first call and edited afterwards. Call it when a stage starts, and with stage "failed" plus a one-line reason when you have to give up.',
		input: v.object({
			stage: v.picklist(STAGES),
			note: v.optional(v.pipe(v.string(), v.maxLength(240))),
		}),
		async run({ data }) {
			const result = await upsertRunComment(
				ref,
				run,
				status,
				setStatus,
				renderStatus(data.stage, data.note, run.requestedBy),
			);
			return { output: { ...result, stage: data.stage } };
		},
	});
}

/** Narrations per pull request, across runs; a cost guard, not a feature. */
const MAX_NARRATIONS = 6;

// ---------------------------------------------------------------------------
// Render and publish: the only path from the container to the outside world.
// The check gate, the render, the verification and the upload are code; the
// model gets URLs back and nothing else. The file goes to the private bucket
// and is reachable only through its signed URL, which lives in the PR comment.
// ---------------------------------------------------------------------------

type Published = v.InferOutput<typeof publishedSchema>;

/** Objects of one run: `<owner>/<repo>/pr-<n>/<delivery id>/…`. */
function runPrefix(ref: Target, run: RunInfo): string {
	return `${pullRequestPrefix(ref)}${run.deliveryId.replace(/[^A-Za-z0-9_-]/g, '')}/`;
}

function renderAndPublish(ref: Target, run: RunInfo, setPublished: (next: Published | null) => void) {
	return defineTool({
		name: 'render_and_publish',
		description: `Render the HyperFrames project and publish the result: ${RENDER_DESCRIPTION}, stores the video and the poster, and returns the video URL, the poster URL, the measured duration and the file size. Call it when check passes; call it again after fixing whatever it reports.`,
		harness: true,
		timeoutMs: 40 * 60_000,
		async run({ harness, log }) {
			const sandbox = harness.sandbox;
			const rendered = await renderVideo(sandbox, { project: PROJECT, outputDir: OUTPUT_DIR }, log);

			log.info('Storing');
			const prefix = runPrefix(ref, run);
			await putObject(`${prefix}explainer.mp4`, await sandbox.readFileBuffer(rendered.videoPath), 'video/mp4');
			let posterUrl = '';
			if (rendered.posterPath) {
				await putObject(`${prefix}poster.jpg`, await sandbox.readFileBuffer(rendered.posterPath), 'image/jpeg');
				posterUrl = await objectUrl(`${prefix}poster.jpg`);
			}

			const result: Published = {
				deliveryId: run.deliveryId,
				videoUrl: await objectUrl(`${prefix}explainer.mp4`),
				posterUrl,
				durationSeconds: rendered.durationSeconds,
				sizeBytes: rendered.sizeBytes,
			};
			setPublished(result);
			return { output: result };
		},
	});
}

// ---------------------------------------------------------------------------
// The final comment: rendered here, so it always links the file this run
// produced, with the poster, the duration and a bounded summary. It also
// records what the channel needs to rewrite the comment when the PR closes.
// ---------------------------------------------------------------------------

/**
 * The explainer comment. With `video`, it shows the poster linking to the
 * film; without, it is the same comment after the video was removed (the
 * channel renders that form when the pull request closes).
 */
export function renderExplainerComment(input: {
	number: number;
	requestedBy: string;
	summary: string;
	covers: string[];
	video: { videoUrl: string; posterUrl: string; durationSeconds: number } | null;
}): string {
	const lines = [`## 🎬 Explainer video for #${input.number}`, ''];
	if (input.video) {
		if (input.video.posterUrl) {
			lines.push(`[![Explainer video poster](${input.video.posterUrl})](${input.video.videoUrl})`, '');
		}
		lines.push(
			`**[▶ Watch the video](${input.video.videoUrl})** · ${fmtDuration(input.video.durationSeconds)}`,
			'',
		);
	} else {
		lines.push('_The video was removed when the pull request closed._', '');
	}
	lines.push(
		input.summary,
		'',
		'**What it covers**',
		...input.covers.map((c) => `- ${c}`),
		'',
		`<sub>Requested by @${input.requestedBy} with \`/explain-vid\`. Narrated with ElevenLabs, rendered with HyperFrames from the diff; an overview, not a review. The video is available for ${RETENTION_DAYS} days or until the pull request closes.</sub>`,
	);
	return lines.join('\n');
}

function postExplainerComment(
	ref: Target,
	run: RunInfo,
	status: Status | null,
	setStatus: StatusSetter,
	published: Published | null,
) {
	return defineTool({
		name: 'post_explainer_comment',
		description:
			'Post the finished explainer on the pull request: poster, play link, duration, a one-sentence summary and 2–4 bullets of what the video covers. Replaces the progress comment. The videoUrl must be the one render_and_publish returned in this run.',
		input: v.object({
			videoUrl: v.pipe(v.string(), v.url()),
			summary: v.pipe(v.string(), v.minLength(20), v.maxLength(300)),
			covers: v.pipe(
				v.array(v.pipe(v.string(), v.minLength(5), v.maxLength(140))),
				v.minLength(2),
				v.maxLength(4),
			),
		}),
		async run({ data }) {
			if (!published || published.deliveryId !== run.deliveryId || published.videoUrl !== data.videoUrl) {
				throw new Error(
					'videoUrl is not the video render_and_publish produced in this run. Render first, then pass its URL.',
				);
			}
			const body = renderExplainerComment({
				number: ref.number,
				requestedBy: run.requestedBy,
				summary: data.summary,
				covers: data.covers,
				video: published,
			});
			const result = await upsertRunComment(ref, run, status, setStatus, body);
			await putRunMeta(runPrefix(ref, run), {
				commentId: result.commentId,
				summary: data.summary,
				covers: data.covers,
				requestedBy: run.requestedBy,
				publishedAt: new Date().toISOString(),
			});
			return {
				output: { ...result, videoUrl: published.videoUrl, durationSeconds: published.durationSeconds },
			};
		},
	});
}
