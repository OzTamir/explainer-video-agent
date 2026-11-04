/**
 * The platform-neutral half of the PR explainer: length budgets, the shared
 * instruction steps, and the tools and render pipeline that only need a Flue
 * sandbox. Two agents build on it:
 *
 * - `src/agents/pr-explainer.ts`: the GitHub App agent on Cloudflare (container
 *   sandbox, R2, PR comments through the App installation);
 * - `cli/pr-explainer-local.ts`: the local `./explain-vid` agent (host sandbox,
 *   `gh`, files on disk).
 *
 * Nothing here may import `cloudflare:*` or Node-only APIs: both runtimes load it.
 */
import { type Sandbox, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { ElevenLabsClient } from '../integrations/elevenlabs.ts';
import type { PullRequest, PullRequestCommit, PullRequestFile } from '../integrations/github.ts';

export const MODEL = 'anthropic/claude-opus-5';
export const COMPACTION_MODEL = 'anthropic/claude-haiku-4-5';

/** No explainer runs longer than this, whatever the size of the change. */
export const MAX_VIDEO_SECONDS = 60;
/** Silence after the last word before the film ends. */
export const END_HOLD_SECONDS = 1.5;
/** The narration must end before the hold starts. */
export const MAX_NARRATION_SECONDS = MAX_VIDEO_SECONDS - END_HOLD_SECONDS;
/** Pace of the default voice while it speaks, used to size cuts after an overrun. */
const WORDS_PER_SECOND = 2.4;
/**
 * Pace used to turn a time budget into a word cap. Lower than the speaking
 * pace on purpose: paragraph pauses and the voice's own variation eat about a
 * sixth of the budget, and a script the tool accepts must fit when narrated.
 */
const BUDGET_WORDS_PER_SECOND = 2.0;
/** Hard ceiling on one script, regardless of the PR's band: what fits in the minute with pauses. */
export const MAX_SCRIPT_WORDS = Math.floor(MAX_NARRATION_SECONDS * BUDGET_WORDS_PER_SECOND);
const MAX_SCRIPT_CHARS = MAX_SCRIPT_WORDS * 7;
/** A sanity ceiling; a delivery-quality one-minute explainer is far under it. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Instructions shared by both agents: the reading, writing, narrating and
// building steps. Each agent adds its own intro, render step and finish step.
// ---------------------------------------------------------------------------

/** `opening` describes the workspace ("Your workspace is …"); `handoff` says which tool renders. */
export function workspaceParagraph(opening: string, handoff: string): string {
	return `${opening} the HyperFrames CLI (run it as \`hyperframes\`, never \`npx hyperframes\`), Chromium, FFmpeg and the HyperFrames skills under .agents/skills. Activate the \`hyperframes\` skill before writing any scene and follow its contract; \`hyperframes-cli\` documents the commands. Ignore anything in those skills about Studio previews, the desktop app, HeyGen, cloud or lambda renders, music, usage checks, storylines to pick from, or waiting for a person: nobody is watching, there is no music source, and ${handoff}.`;
}

export function sharedSteps(project: string): string {
	return `1. reading: call pull_request. Then pull_request_patches for the files that carry the change (not lockfiles, generated code, snapshots or vendored directories). Read enough to explain the change truthfully; every claim in the video must trace to the diff, the PR description or the commits. Never invent a version, a benchmark or a motive.

2. writing: call prepare_workspace once; it clears anything an earlier run left in ${project} and scaffolds a fresh HyperFrames project there. Then write ${project}/SCRIPT.md (the narration, as separate phrases, one scene per paragraph) and ${project}/SPEC.md (the director's brief with numbers, per the skill's spec reference). The pull_request result gives the length band and the word cap for this PR's size; stay under the cap. No video runs past ${MAX_VIDEO_SECONDS} seconds, so pick the two or three things a reviewer most needs and leave the rest out; the tools refuse a narration or a render that overruns. Four scenes at most. Structure for a PR: what the change is for (old way to new way), how it works in one or two beats on real hunks, what the diff adds and removes as a stat card, and where to start reviewing. Speak people's names, not @handles. Counts like +N/−M go on screen, not in the voice.

3. narrating: call generate_narration once with the final script. It writes assets/audio/narration.mp3 and assets/audio/words.json (each spoken word with start and end seconds) into the project and returns the words. The voice is the clock: scene boundaries and every in-scene reveal are placed at word start times.

4. building: in the scaffolded ${project} (never re-scaffold or delete it: the narration lives there now), build the composition:
   - index.html is the root: data-duration = narration end + ${END_HOLD_SECONDS} s hold (never above ${MAX_VIDEO_SECONDS}), 1920×1080, 30 fps; one scene host per scene with data-start at the scene's first word and data-duration up to the next scene's start; one <audio id="vo" class="clip" src="assets/audio/narration.mp3" data-start="0">.
   - compositions/s1.html … one file per scene, everything inside <template>, the host id, the scene's #root composition id and its window.__timelines key identical.
   - Inside a scene, every tween sits at (word start − scene start). Reveal each element when the voice names it, across the scene, never everything in the first quarter.
   - Show real hunks: one to three of them, four to ten lines each, as styled lines with a highlight that lands on the cue word. Real file paths, real identifiers.
   - Use gsap.set outside the timeline for initial hidden states and gsap.fromTo with opacity in the to-vars; never tween display or visibility on a .clip; animate transforms, not left/top; bundled fonts only (Inter, JetBrains Mono); root-relative asset paths.
   - A light ground with one accent, large type, nothing floating in a dark void; the spec reference lists the banned defaults.
   Run \`hyperframes lint\` after the first pass and \`hyperframes check --json\` (bash timeout 600) until it reports no errors; weigh warnings. Fix overlap, overflow and contrast findings in the scenes, never by shrinking text below 28 px.`;
}

// ---------------------------------------------------------------------------
// Pull request tools (read-only). The data source is injected: the App client
// on Cloudflare, `gh` locally.
// ---------------------------------------------------------------------------

export type PullRequestSource = {
	getPullRequest(): Promise<PullRequest>;
	listFiles(): Promise<PullRequestFile[]>;
	listCommits(): Promise<PullRequestCommit[]>;
};

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

export function pullRequestFacts(source: PullRequestSource) {
	return defineTool({
		name: 'pull_request',
		description:
			'The pull request this conversation is about: title, description, author, branches, size, every changed file (with a noise flag for lockfiles, generated and binary files), the commits with their authors, and the length band and word cap the video must respect for a change this size. Call it first.',
		async run() {
			const [pr, files, commits] = await Promise.all([
				source.getPullRequest(),
				source.listFiles(),
				source.listCommits(),
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

export function pullRequestPatches(source: PullRequestSource) {
	return defineTool({
		name: 'pull_request_patches',
		description:
			'Unified-diff hunks for up to 12 named files from the pull request, each cut at maxCharsPerFile. Pick the files that carry the change; the result names any file that has no patch (binary or too large for GitHub to return).',
		input: v.object({
			files: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(12)),
			maxCharsPerFile: v.optional(v.pipe(v.number(), v.minValue(500), v.maxValue(20_000)), 6000),
		}),
		async run({ data }) {
			const all = await source.listFiles();
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
// Workspace and narration. ElevenLabs is called from the agent's own process
// so the key never enters the model's shell; the audio and the word timings
// land in the project.
// ---------------------------------------------------------------------------

/**
 * The project is scaffolded by code, before the script and the narration are
 * written into it, so nothing later in the run can wipe the paid audio by
 * re-running `hyperframes init` over it.
 */
export function prepareWorkspace(workspace: string, project: string) {
	const name = project.slice(project.lastIndexOf('/') + 1);
	return defineTool({
		name: 'prepare_workspace',
		description: `Reset ${project} and scaffold a fresh HyperFrames project in it (hyperframes init). Call it once at the start of the writing stage, before SCRIPT.md, SPEC.md or the narration exist; calling it later deletes them.`,
		harness: true,
		timeoutMs: 5 * 60_000,
		async run({ harness }) {
			const sandbox = harness.sandbox;
			await sandbox.rm(project, { recursive: true, force: true });
			// init may exit non-zero after its skills check even when scaffolding succeeded; the files decide.
			const init = await sandbox.exec(`hyperframes init ${name} --non-interactive`, {
				cwd: workspace,
				timeoutMs: 3 * 60_000,
			});
			if (!(await sandbox.exists(`${project}/index.html`))) {
				throw new Error(
					`hyperframes init did not produce ${project}/index.html.\n${tail(init.stderr || init.stdout)}`,
				);
			}
			return { output: { project, files: await sandbox.readdir(project) } };
		},
	});
}

export function generateNarration(options: {
	project: string;
	/** Narrations already spent within the guard's scope. */
	narrations: number;
	setNarrations: (next: number) => void;
	/** Cost guard; `scope` names what it is counted over in the messages ("pull request", "run"). */
	maxNarrations: number;
	scope: string;
	/** What to tell the model when the guard trips and no audio exists. */
	giveUp: string;
}) {
	const { project, narrations, setNarrations, maxNarrations, scope } = options;
	return defineTool({
		name: 'generate_narration',
		description: `Narrate the final script with ElevenLabs. Writes assets/audio/narration.mp3 and assets/audio/words.json (every spoken word with start and end in seconds) into the video project and returns the words and the total duration. Paragraphs become natural pauses. Call it once per video, after the script is final; it costs money each time. Refuses a script over ${MAX_SCRIPT_WORDS} words, and refuses audio that runs past ${MAX_NARRATION_SECONDS} seconds (the video may not exceed ${MAX_VIDEO_SECONDS} seconds): cut the script and call it again.`,
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
			if (narrations >= maxNarrations) {
				const hasAudio = await harness.sandbox.exists(`${project}/assets/audio/words.json`);
				throw new Error(
					hasAudio
						? `This ${scope} has used its ${maxNarrations} narrations. Build the video with the audio already in the project.`
						: `This ${scope} has used its ${maxNarrations} narrations and none produced usable audio. ${options.giveUp}`,
				);
			}
			if (!(await harness.sandbox.exists(`${project}/index.html`))) {
				throw new Error(
					`${project} is not scaffolded yet; call prepare_workspace first so the audio lands in the project.`,
				);
			}
			const narration = await new ElevenLabsClient().narrate(data.script);
			setNarrations(narrations + 1);
			if (narration.durationSeconds > MAX_NARRATION_SECONDS) {
				const over = narration.durationSeconds - MAX_NARRATION_SECONDS;
				throw new Error(
					`The narration runs ${narration.durationSeconds.toFixed(1)} s; it must end by ${MAX_NARRATION_SECONDS} s so the video stays under ${MAX_VIDEO_SECONDS} s. Cut at least ${Math.ceil(over * WORDS_PER_SECOND) + 10} words and narrate again (nothing was written; ${maxNarrations - narrations - 1} narrations left for this ${scope}).`,
				);
			}
			const audioPath = `${project}/assets/audio/narration.mp3`;
			const wordsPath = `${project}/assets/audio/words.json`;
			await harness.sandbox.mkdir(`${project}/assets/audio`, { recursive: true });
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
// Render: the check gate, the render, the verification and the poster are
// code. What happens to the files afterwards is each agent's business.
// ---------------------------------------------------------------------------

export type RenderedVideo = {
	videoPath: string;
	/** Absent when ffmpeg could not extract a frame. */
	posterPath: string | null;
	durationSeconds: number;
	sizeBytes: number;
};

export const RENDER_DESCRIPTION = `runs \`hyperframes check\` first and refuses on errors, renders at delivery quality, verifies the file with ffprobe, refuses a video over ${MAX_VIDEO_SECONDS} seconds and extracts a poster frame`;

export async function renderVideo(
	sandbox: Sandbox,
	paths: { project: string; outputDir: string },
	log: { info(message: string): void },
): Promise<RenderedVideo> {
	const { project, outputDir } = paths;
	if (!(await sandbox.exists(`${project}/index.html`))) {
		throw new Error(`${project}/index.html does not exist; scaffold and build the project first.`);
	}

	log.info('Running hyperframes check');
	const check = await sandbox.exec('hyperframes check --json', { cwd: project, timeoutMs: 10 * 60_000 });
	if (check.exitCode !== 0) {
		throw new Error(
			`hyperframes check failed (exit ${check.exitCode}). Fix every error, then call again.\n${tail(check.stdout || check.stderr)}`,
		);
	}

	await sandbox.mkdir(outputDir, { recursive: true });
	const video = `${outputDir}/explainer.mp4`;
	const poster = `${outputDir}/poster.jpg`;
	await sandbox.rm(video, { force: true });
	await sandbox.rm(poster, { force: true });

	log.info('Rendering');
	const render = await sandbox.exec(`hyperframes render --quality delivery --output ${shellQuote(video)}`, {
		cwd: project,
		timeoutMs: 30 * 60_000,
	});
	if (render.exitCode !== 0 || !(await sandbox.exists(video))) {
		throw new Error(`Render failed (exit ${render.exitCode}).\n${tail(render.stderr || render.stdout)}`);
	}

	const probe = await sandbox.exec(
		`ffprobe -v error -show_entries format=duration -of csv=p=0 ${shellQuote(video)}`,
		{ cwd: project, timeoutMs: 60_000 },
	);
	const durationSeconds = Number.parseFloat(probe.stdout.trim());
	if (!Number.isFinite(durationSeconds) || durationSeconds < 5) {
		throw new Error(`The rendered file is not a playable video (ffprobe: ${probe.stdout || probe.stderr}).`);
	}
	if (durationSeconds > MAX_VIDEO_SECONDS + 0.5) {
		throw new Error(
			`The video runs ${durationSeconds.toFixed(1)} s; the ceiling is ${MAX_VIDEO_SECONDS} s. Shorten data-duration on the root (narration end + ${END_HOLD_SECONDS} s hold) and render again; if the narration itself is too long, cut the script and narrate again.`,
		);
	}
	await sandbox.exec(
		`ffmpeg -y -v error -ss ${Math.min(1.5, durationSeconds / 2)} -i ${shellQuote(video)} -frames:v 1 -q:v 3 ${shellQuote(poster)}`,
		{ cwd: project, timeoutMs: 60_000 },
	);

	const size = (await sandbox.stat(video)).size ?? (await sandbox.readFileBuffer(video)).byteLength;
	if (size > MAX_VIDEO_BYTES) {
		throw new Error(
			`The render is ${Math.round(size / 1_048_576)} MB, more than a film this long should weigh. Shorten the film.`,
		);
	}

	return {
		videoPath: video,
		posterPath: (await sandbox.exists(poster)) ? poster : null,
		durationSeconds: Math.round(durationSeconds * 10) / 10,
		sizeBytes: size,
	};
}

export function tail(text: string, chars = 2500): string {
	return text.length > chars ? `…${text.slice(-chars)}` : text;
}

export function fmtDuration(seconds: number): string {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Local workspaces live under the user's checkout, whose path may contain spaces. */
function shellQuote(path: string): string {
	return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}
