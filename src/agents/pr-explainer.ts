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
import { ElevenLabsClient } from '../integrations/elevenlabs.ts';
import {
	RETENTION_DAYS,
	objectUrl,
	pullRequestPrefix,
	putObject,
	putRunMeta,
} from '../integrations/explainer-store.ts';
import { GitHubClient, type PullRequestFile, type PullRequestRef } from '../integrations/github.ts';

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
	useModel('anthropic/claude-opus-5', {
		thinkingLevel: 'medium',
		compaction: { model: 'anthropic/claude-haiku-4-5' },
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

	useTool(pullRequestFacts(ref));
	useTool(pullRequestPatches(ref));
	useTool(setStatusComment(ref, run, status, setStatus));
	useTool(prepareWorkspace);
	useTool(generateNarration(narrations, setNarrations));
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

Your workspace is a Linux container with the HyperFrames CLI (run it as \`hyperframes\`, never \`npx hyperframes\`), Chromium, FFmpeg and the HyperFrames skills under .agents/skills. Activate the \`hyperframes\` skill before writing any scene and follow its contract; \`hyperframes-cli\` documents the commands. Ignore anything in those skills about Studio previews, the desktop app, HeyGen, cloud or lambda renders, music, usage checks, storylines to pick from, or waiting for a person: nobody is watching, there is no music source, and rendering and publishing go through the render_and_publish tool.

Do the steps in this order, and call set_status at every stage so the pull request shows progress:

1. reading: call pull_request. Then pull_request_patches for the files that carry the change (not lockfiles, generated code, snapshots or vendored directories). Read enough to explain the change truthfully; every claim in the video must trace to the diff, the PR description or the commits. Never invent a version, a benchmark or a motive.

2. writing: call prepare_workspace once; it clears anything an earlier run left in ${PROJECT} and scaffolds a fresh HyperFrames project there. Then write ${PROJECT}/SCRIPT.md (the narration, as separate phrases, one scene per paragraph) and ${PROJECT}/SPEC.md (the director's brief with numbers, per the skill's spec reference). The pull_request result gives the length band and the word cap for this PR's size; stay under the cap. No video runs past ${MAX_VIDEO_SECONDS} seconds, so pick the two or three things a reviewer most needs and leave the rest out; the tools refuse a narration or a render that overruns. Four scenes at most. Structure for a PR: what the change is for (old way to new way), how it works in one or two beats on real hunks, what the diff adds and removes as a stat card, and where to start reviewing. Speak people's names, not @handles. Counts like +N/−M go on screen, not in the voice.

3. narrating: call generate_narration once with the final script. It writes assets/audio/narration.mp3 and assets/audio/words.json (each spoken word with start and end seconds) into the project and returns the words. The voice is the clock: scene boundaries and every in-scene reveal are placed at word start times.

4. building: in the scaffolded ${PROJECT} (never re-scaffold or delete it: the narration lives there now), build the composition:
   - index.html is the root: data-duration = narration end + ${END_HOLD_SECONDS} s hold (never above ${MAX_VIDEO_SECONDS}), 1920×1080, 30 fps; one scene host per scene with data-start at the scene's first word and data-duration up to the next scene's start; one <audio id="vo" class="clip" src="assets/audio/narration.mp3" data-start="0">.
   - compositions/s1.html … one file per scene, everything inside <template>, the host id, the scene's #root composition id and its window.__timelines key identical.
   - Inside a scene, every tween sits at (word start − scene start). Reveal each element when the voice names it, across the scene, never everything in the first quarter.
   - Show real hunks: one to three of them, four to ten lines each, as styled lines with a highlight that lands on the cue word. Real file paths, real identifiers.
   - Use gsap.set outside the timeline for initial hidden states and gsap.fromTo with opacity in the to-vars; never tween display or visibility on a .clip; animate transforms, not left/top; bundled fonts only (Inter, JetBrains Mono); root-relative asset paths.
   - A light ground with one accent, large type, nothing floating in a dark void; the spec reference lists the banned defaults.
   Run \`hyperframes lint\` after the first pass and \`hyperframes check --json\` (bash timeout 600) until it reports no errors; weigh warnings. Fix overlap, overflow and contrast findings in the scenes, never by shrinking text below 28 px.

5. rendering: call render_and_publish. It re-runs the check as a gate, renders at delivery quality, verifies the file, stores it and returns the video URL, a poster URL and the measured duration. A failed render returns the tail of the log; fix the cause and call it again.

6. done: call post_explainer_comment with the returned video URL, a one-sentence summary and two to four bullets of what the video covers. That call replaces the status comment with the final one.

If a step cannot be completed (missing credentials, a diff too large to read, a render that keeps failing), call set_status with stage "failed" and a one-line reason, then stop. Never post anything else to the pull request. Reply to the signal with a terse log of what you did; only the operator reads it.`;
}

// ---------------------------------------------------------------------------
// Pull request tools (read-only)
// ---------------------------------------------------------------------------

const SKIP_PATTERNS = [
	/(^|\/)package-lock\.json$/,
	/(^|\/)pnpm-lock\.yaml$/,
	/(^|\/)yarn\.lock$/,
	/(^|\/)bun\.lock$/,
	/(^|\/)Cargo\.lock$/,
	/(^|\/)go\.sum$/,
	/(^|\/)dist\//,
	/(^|\/)build\//,
	/(^|\/)vendor\//,
	/(^|\/)node_modules\//,
	/\.snap$/,
	/\.min\.(js|css)$/,
	/\.(png|jpe?g|gif|webp|svg|ico|mp4|mp3|wav|pdf|woff2?|ttf)$/i,
];

function isNoise(file: PullRequestFile): boolean {
	return SKIP_PATTERNS.some((p) => p.test(file.filename));
}

/** No explainer runs longer than this, whatever the size of the change. */
const MAX_VIDEO_SECONDS = 60;
/** Silence after the last word before the film ends. */
const END_HOLD_SECONDS = 1.5;
/** The narration must end before the hold starts. */
const MAX_NARRATION_SECONDS = MAX_VIDEO_SECONDS - END_HOLD_SECONDS;
/** Pace of the default voice while it speaks, used to size cuts after an overrun. */
const WORDS_PER_SECOND = 2.4;
/**
 * Pace used to turn a time budget into a word cap. Lower than the speaking
 * pace on purpose: paragraph pauses and the voice's own variation eat about a
 * sixth of the budget, and a script the tool accepts must fit when narrated.
 */
const BUDGET_WORDS_PER_SECOND = 2.0;

/**
 * Length target from the size of the change, after noise files are removed.
 * Every band sits under MAX_VIDEO_SECONDS; a bigger change earns more of the
 * minute, never more than the minute.
 */
function lengthBand(
	lines: number,
	files: number,
): { minSeconds: number; maxSeconds: number; maxWords: number } {
	const band = (minSeconds: number, maxSeconds: number) => ({
		minSeconds,
		maxSeconds,
		maxWords: Math.min(MAX_SCRIPT_WORDS, Math.floor(maxSeconds * BUDGET_WORDS_PER_SECOND)),
	});
	if (lines >= 600 || files >= 25) return band(45, MAX_VIDEO_SECONDS);
	if (lines >= 200) return band(35, 50);
	if (lines >= 50) return band(25, 40);
	return band(15, 25);
}

function pullRequestFacts(ref: Target) {
	return defineTool({
		name: 'pull_request',
		description:
			'The pull request this conversation is about: title, description, author, branches, size, every changed file (with a noise flag for lockfiles, generated and binary files), the commits with their authors, and the length band and word cap the video must respect for a change this size. Call it first.',
		async run() {
			const github = new GitHubClient(ref.installationId);
			const [pr, files, commits] = await Promise.all([
				github.getPullRequest(ref),
				github.listPullRequestFiles(ref),
				github.listPullRequestCommits(ref),
			]);
			const substantive = files.filter((f) => !isNoise(f));
			const lines = substantive.reduce((n, f) => n + f.additions + f.deletions, 0);
			const authors = new Map<string, { login: string | null; name: string | null; commits: number }>();
			for (const c of commits) {
				const key = c.authorLogin ?? c.authorName ?? 'unknown';
				if (/\[bot\]$/i.test(key) || /\bbot\b/i.test(c.authorName ?? '')) continue;
				const entry = authors.get(key) ?? { login: c.authorLogin, name: c.authorName, commits: 0 };
				entry.commits += 1;
				authors.set(key, entry);
			}
			return {
				output: {
					...pr,
					body: pr.body.slice(0, 6000),
					files: files.map((f) => ({
						filename: f.filename,
						status: f.status,
						additions: f.additions,
						deletions: f.deletions,
						noise: isNoise(f),
						hasPatch: Boolean(f.patch),
					})),
					commits: commits.slice(0, 50).map((c) => ({
						sha: c.sha.slice(0, 7),
						subject: c.subject,
						author: c.authorLogin ?? c.authorName,
					})),
					authors: [...authors.values()].sort((a, b) => b.commits - a.commits),
					substantiveLines: lines,
					substantiveFiles: substantive.length,
					video: lengthBand(lines, substantive.length),
				},
			};
		},
	});
}

function pullRequestPatches(ref: Target) {
	return defineTool({
		name: 'pull_request_patches',
		description:
			'Unified-diff hunks for up to 12 named files from the pull request, each cut at maxCharsPerFile. Pick the files that carry the change; the result names any file that has no patch (binary or too large for GitHub to return).',
		input: v.object({
			files: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(12)),
			maxCharsPerFile: v.optional(v.pipe(v.number(), v.minValue(500), v.maxValue(20_000)), 6000),
		}),
		async run({ data }) {
			const all = await new GitHubClient(ref.installationId).listPullRequestFiles(ref);
			const wanted = new Set(data.files);
			const found = all.filter((f) => wanted.has(f.filename));
			const missing = data.files.filter((name) => !all.some((f) => f.filename === name));
			return {
				output: {
					patches: found.map((f) => ({
						filename: f.filename,
						status: f.status,
						additions: f.additions,
						deletions: f.deletions,
						truncated: (f.patch?.length ?? 0) > data.maxCharsPerFile,
						patch: f.patch ? f.patch.slice(0, data.maxCharsPerFile) : null,
					})),
					notInPullRequest: missing,
				},
			};
		},
	});
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

// ---------------------------------------------------------------------------
// Narration: ElevenLabs is called from the Worker so the key never enters
// the container. The audio and the word timings land in the project.
// ---------------------------------------------------------------------------

/**
 * The project is scaffolded by code, before the script and the narration are
 * written into it, so nothing later in the run can wipe the paid audio by
 * re-running `hyperframes init` over it.
 */
const prepareWorkspace = defineTool({
	name: 'prepare_workspace',
	description: `Reset ${PROJECT} and scaffold a fresh HyperFrames project in it (hyperframes init). Call it once at the start of the writing stage, before SCRIPT.md, SPEC.md or the narration exist; calling it later deletes them.`,
	harness: true,
	timeoutMs: 5 * 60_000,
	async run({ harness }) {
		const sandbox = harness.sandbox;
		await sandbox.rm(PROJECT, { recursive: true, force: true });
		// init may exit non-zero after its skills check even when scaffolding succeeded; the files decide.
		const init = await sandbox.exec('hyperframes init explainer --non-interactive', {
			cwd: WORKSPACE,
			timeoutMs: 3 * 60_000,
		});
		if (!(await sandbox.exists(`${PROJECT}/index.html`))) {
			throw new Error(
				`hyperframes init did not produce ${PROJECT}/index.html.\n${tail(init.stderr || init.stdout)}`,
			);
		}
		return { output: { project: PROJECT, files: await sandbox.readdir(PROJECT) } };
	},
});

/** Hard ceiling on one script, regardless of the PR's band: what fits in the minute with pauses. */
const MAX_SCRIPT_WORDS = Math.floor(MAX_NARRATION_SECONDS * BUDGET_WORDS_PER_SECOND);
const MAX_SCRIPT_CHARS = MAX_SCRIPT_WORDS * 7;
/** Narrations per pull request, across runs; a cost guard, not a feature. */
const MAX_NARRATIONS = 6;

function generateNarration(narrations: number, setNarrations: (next: number) => void) {
	return defineTool({
		name: 'generate_narration',
		description:
			`Narrate the final script with ElevenLabs. Writes assets/audio/narration.mp3 and assets/audio/words.json (every spoken word with start and end in seconds) into the video project and returns the words and the total duration. Paragraphs become natural pauses. Call it once per video, after the script is final; it costs money each time. Refuses a script over ${MAX_SCRIPT_WORDS} words, and refuses audio that runs past ${MAX_NARRATION_SECONDS} seconds (the video may not exceed ${MAX_VIDEO_SECONDS} seconds): cut the script and call it again.`,
		input: v.object({ script: v.pipe(v.string(), v.minLength(40), v.maxLength(MAX_SCRIPT_CHARS)) }),
		harness: true,
		timeoutMs: 5 * 60_000,
		async run({ data, harness }) {
			const words = data.script.split(/\s+/).filter(Boolean).length;
			if (words > MAX_SCRIPT_WORDS) {
				throw new Error(
					`The script is ${words} words; the ceiling is ${MAX_SCRIPT_WORDS}. Cut it before narrating.`,
				);
			}
			if (narrations >= MAX_NARRATIONS) {
				const hasAudio = await harness.sandbox.exists(`${PROJECT}/assets/audio/words.json`);
				throw new Error(
					hasAudio
						? `This pull request has used its ${MAX_NARRATIONS} narrations. Build the video with the audio already in the project.`
						: `This pull request has used its ${MAX_NARRATIONS} narrations and none produced usable audio. Call set_status with stage "failed" and stop.`,
				);
			}
			if (!(await harness.sandbox.exists(`${PROJECT}/index.html`))) {
				throw new Error(
					`${PROJECT} is not scaffolded yet; call prepare_workspace first so the audio lands in the project.`,
				);
			}
			const narration = await new ElevenLabsClient().narrate(data.script);
			setNarrations(narrations + 1);
			if (narration.durationSeconds > MAX_NARRATION_SECONDS) {
				const over = narration.durationSeconds - MAX_NARRATION_SECONDS;
				throw new Error(
					`The narration runs ${narration.durationSeconds.toFixed(1)} s; it must end by ${MAX_NARRATION_SECONDS} s so the video stays under ${MAX_VIDEO_SECONDS} s. Cut at least ${Math.ceil(over * WORDS_PER_SECOND) + 10} words and narrate again (nothing was written; ${MAX_NARRATIONS - narrations - 1} narrations left for this pull request).`,
				);
			}
			const audioPath = `${PROJECT}/assets/audio/narration.mp3`;
			const wordsPath = `${PROJECT}/assets/audio/words.json`;
			await harness.sandbox.mkdir(`${PROJECT}/assets/audio`, { recursive: true });
			await harness.sandbox.writeFile(audioPath, narration.audio);
			await harness.sandbox.writeFile(wordsPath, JSON.stringify(narration.words, null, 1));
			return {
				output: {
					audioPath,
					wordsPath,
					durationSeconds: narration.durationSeconds,
					wordCount: narration.words.length,
					voiceId: narration.voiceId,
					modelId: narration.modelId,
					words: narration.words,
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Render and publish: the only path from the container to the outside world.
// The check gate, the render, the verification and the upload are code; the
// model gets URLs back and nothing else. The file goes to the private bucket
// and is reachable only through its signed URL, which lives in the PR comment.
// ---------------------------------------------------------------------------

type Published = v.InferOutput<typeof publishedSchema>;

/** A sanity ceiling; a delivery-quality one-minute explainer is far under it. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function tail(text: string, chars = 2500): string {
	return text.length > chars ? `…${text.slice(-chars)}` : text;
}

/** Objects of one run: `<owner>/<repo>/pr-<n>/<delivery id>/…`. */
function runPrefix(ref: Target, run: RunInfo): string {
	return `${pullRequestPrefix(ref)}${run.deliveryId.replace(/[^A-Za-z0-9_-]/g, '')}/`;
}

function renderAndPublish(ref: Target, run: RunInfo, setPublished: (next: Published | null) => void) {
	return defineTool({
		name: 'render_and_publish',
		description:
			`Render the HyperFrames project at delivery quality and publish the result. Runs \`hyperframes check\` first and refuses on errors, renders, verifies the file with ffprobe, refuses a video over ${MAX_VIDEO_SECONDS} seconds, extracts a poster frame, stores both, and returns the video URL, the poster URL, the measured duration and the file size. Call it when check passes; call it again after fixing whatever it reports.`,
		harness: true,
		timeoutMs: 40 * 60_000,
		async run({ harness, log }) {
			const sandbox = harness.sandbox;
			if (!(await sandbox.exists(`${PROJECT}/index.html`))) {
				throw new Error(`${PROJECT}/index.html does not exist; scaffold and build the project first.`);
			}

			log.info('Running hyperframes check');
			const check = await sandbox.exec('hyperframes check --json', { cwd: PROJECT, timeoutMs: 10 * 60_000 });
			if (check.exitCode !== 0) {
				throw new Error(
					`hyperframes check failed (exit ${check.exitCode}). Fix every error, then call again.\n${tail(check.stdout || check.stderr)}`,
				);
			}

			await sandbox.mkdir(OUTPUT_DIR, { recursive: true });
			const video = `${OUTPUT_DIR}/explainer.mp4`;
			const poster = `${OUTPUT_DIR}/poster.jpg`;
			await sandbox.rm(video, { force: true });
			await sandbox.rm(poster, { force: true });

			log.info('Rendering');
			const render = await sandbox.exec(`hyperframes render --quality delivery --output ${video}`, {
				cwd: PROJECT,
				timeoutMs: 30 * 60_000,
			});
			if (render.exitCode !== 0 || !(await sandbox.exists(video))) {
				throw new Error(`Render failed (exit ${render.exitCode}).\n${tail(render.stderr || render.stdout)}`);
			}

			const probe = await sandbox.exec(
				`ffprobe -v error -show_entries format=duration -of csv=p=0 ${video}`,
				{ cwd: PROJECT, timeoutMs: 60_000 },
			);
			const durationSeconds = Number.parseFloat(probe.stdout.trim());
			if (!Number.isFinite(durationSeconds) || durationSeconds < 5) {
				throw new Error(
					`The rendered file is not a playable video (ffprobe: ${probe.stdout || probe.stderr}).`,
				);
			}
			if (durationSeconds > MAX_VIDEO_SECONDS + 0.5) {
				throw new Error(
					`The video runs ${durationSeconds.toFixed(1)} s; the ceiling is ${MAX_VIDEO_SECONDS} s. Shorten data-duration on the root (narration end + ${END_HOLD_SECONDS} s hold) and render again; if the narration itself is too long, cut the script and narrate again.`,
				);
			}
			await sandbox.exec(
				`ffmpeg -y -v error -ss ${Math.min(1.5, durationSeconds / 2)} -i ${video} -frames:v 1 -q:v 3 ${poster}`,
				{ cwd: PROJECT, timeoutMs: 60_000 },
			);

			const bytes = await sandbox.readFileBuffer(video);
			if (bytes.byteLength > MAX_VIDEO_BYTES) {
				throw new Error(
					`The render is ${Math.round(bytes.byteLength / 1_048_576)} MB, more than a film this long should weigh. Shorten the film.`,
				);
			}

			log.info('Storing');
			const prefix = runPrefix(ref, run);
			await putObject(`${prefix}explainer.mp4`, bytes, 'video/mp4');
			let posterUrl = '';
			if (await sandbox.exists(poster)) {
				await putObject(`${prefix}poster.jpg`, await sandbox.readFileBuffer(poster), 'image/jpeg');
				posterUrl = await objectUrl(`${prefix}poster.jpg`);
			}

			const result: Published = {
				deliveryId: run.deliveryId,
				videoUrl: await objectUrl(`${prefix}explainer.mp4`),
				posterUrl,
				durationSeconds: Math.round(durationSeconds * 10) / 10,
				sizeBytes: bytes.byteLength,
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

function fmtDuration(seconds: number): string {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

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
