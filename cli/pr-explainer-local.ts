'use agent';
/**
 * The local variant of the PR explainer, run by `./explain-vid <pr-link>`
 * through `flue run`. Same steps, budgets, narration and render gate as the
 * GitHub App agent (src/explainer/core.ts), with three differences:
 *
 * - the pull request is read with the GitHub CLI (`gh`), as the user running it;
 * - the sandbox is the host (`local()`), in a workspace directory the wrapper
 *   creates under out/; the HyperFrames CLI comes from node_modules/.bin;
 * - nothing is uploaded or posted: the video stays on disk, and the agent
 *   writes the comment text to a file the wrapper may post with `gh pr comment`.
 *
 * Lives outside src/ on purpose: Flue scans src/ for `'use agent'` modules to
 * build the Worker, and this one imports Node-only code.
 */
import {
	defineTool,
	useInitialData,
	useModel,
	usePersistentState,
	useSandbox,
	useTool,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import {
	COMPACTION_MODEL,
	MODEL,
	RENDER_DESCRIPTION,
	type RenderedVideo,
	fmtDuration,
	generateNarration,
	prepareWorkspace,
	pullRequestFacts,
	pullRequestPatches,
	renderVideo,
	sharedSteps,
	workspaceParagraph,
} from '../src/explainer/core.ts';
import { ghSource } from './gh.ts';

export const initialData = v.object({
	owner: v.string(),
	repo: v.string(),
	number: v.pipe(v.number(), v.integer(), v.minValue(1)),
	title: v.string(),
	openedBy: v.string(),
	/** Absolute path of this run's workspace, created by the wrapper (out/<owner>/<repo>/pr-<n>). */
	workspace: v.pipe(v.string(), v.startsWith('/')),
});
export type PrExplainerLocalInitialData = v.InferOutput<typeof initialData>;

/** Narrations per run; a cost guard, not a feature. */
const MAX_NARRATIONS = 3;

export function PrExplainerLocal() {
	useModel(MODEL, {
		thinkingLevel: 'medium',
		compaction: { model: COMPACTION_MODEL },
	});

	const pr = useInitialData<PrExplainerLocalInitialData>();
	const workspace = pr.workspace;
	const project = `${workspace}/explainer`;

	// The host shell, in the workspace. local() passes only shell essentials
	// (PATH, HOME, …), never API keys; the wrapper put node_modules/.bin on PATH.
	useSandbox(
		local({
			cwd: workspace,
			env: {
				HYPERFRAMES_SKIP_SKILLS: '1',
				HYPERFRAMES_NO_UPDATE_CHECK: '1',
				HYPERFRAMES_NO_TELEMETRY: '1',
				// Keeps the model's `gh` logged out so it does not reach for it. Not a
				// security boundary: the shell runs as you (see docs/security.md).
				GH_CONFIG_DIR: `${workspace}/.gh-logged-out`,
			},
		}),
	);

	const [narrations, setNarrations] = usePersistentState<number>('narrations', 0);
	const [rendered, setRendered] = usePersistentState<RenderedVideo | null>('rendered', null);

	const source = ghSource({ owner: pr.owner, repo: pr.repo, number: pr.number });
	useTool(pullRequestFacts(source));
	useTool(pullRequestPatches(source));
	useTool(prepareWorkspace(workspace, project));
	useTool(
		generateNarration({
			project,
			narrations,
			setNarrations,
			maxNarrations: MAX_NARRATIONS,
			scope: 'run',
			giveUp: 'Stop and reply with the reason.',
		}),
	);
	useTool(renderToDisk(project, workspace, setRendered));
	useTool(saveExplainer(pr, workspace, rendered));

	return instructions(pr, workspace, project);
}

PrExplainerLocal.initialData = initialData;

function instructions(pr: PrExplainerLocalInitialData, workspace: string, project: string): string {
	return `You turn one GitHub pull request into a short narrated explainer video, rendered to a file on the user's machine. This conversation is bound to ${pr.owner}/${pr.repo}#${pr.number} ("${pr.title}", opened by ${pr.openedBy}). If the user's message carries a note, honor it (a focus area, a length, an audience); otherwise explain the change for an engineer who has not read the diff.

${workspaceParagraph(`Your workspace is ${workspace}, a directory on the user's own computer, with`, 'rendering goes through the render_video tool')} Work only inside ${workspace}: never read or change files outside it, never run git or gh, never install anything, and never fetch anything from the network; the tools give you the pull request.

Do the steps in this order:

${sharedSteps(project)}

5. rendering: call render_video. It ${RENDER_DESCRIPTION}, and returns the file paths and the measured duration. A failed render returns the tail of the log; fix the cause and call it again.

6. done: call save_explainer with a one-sentence summary and two to four bullets of what the video covers.

If a step cannot be completed (missing credentials, a diff too large to read, a render that keeps failing), stop and reply with a one-line reason. Otherwise reply with a terse log of what you did.`;
}

function renderToDisk(project: string, workspace: string, setRendered: (next: RenderedVideo | null) => void) {
	return defineTool({
		name: 'render_video',
		description: `Render the HyperFrames project to ${workspace}/explainer.mp4: ${RENDER_DESCRIPTION}. Returns the video and poster paths, the measured duration and the file size. Call it when check passes; call it again after fixing whatever it reports.`,
		harness: true,
		timeoutMs: 40 * 60_000,
		async run({ harness, log }) {
			setRendered(null);
			const result = await renderVideo(harness.sandbox, { project, outputDir: workspace }, log);
			setRendered(result);
			return { output: result };
		},
	});
}

/**
 * Records the outcome for the wrapper: comment.md (what `--comment` posts)
 * and summary.json. Rendered here so the text always matches this run's file.
 */
function saveExplainer(pr: PrExplainerLocalInitialData, workspace: string, rendered: RenderedVideo | null) {
	return defineTool({
		name: 'save_explainer',
		description:
			'Record the finished explainer: a one-sentence summary and 2–4 bullets of what the video covers. Call it once, after render_video succeeded.',
		input: v.object({
			summary: v.pipe(v.string(), v.minLength(20), v.maxLength(300)),
			covers: v.pipe(
				v.array(v.pipe(v.string(), v.minLength(5), v.maxLength(140))),
				v.minLength(2),
				v.maxLength(4),
			),
		}),
		harness: true,
		async run({ data, harness }) {
			if (!rendered || !(await harness.sandbox.exists(rendered.videoPath))) {
				throw new Error('No rendered video in this run. Call render_video first.');
			}
			const comment = [
				`## 🎬 Explainer video for #${pr.number}`,
				'',
				`A ${fmtDuration(rendered.durationSeconds)} narrated walkthrough of this pull request.`,
				'',
				data.summary,
				'',
				'**What it covers**',
				...data.covers.map((c) => `- ${c}`),
				'',
				'<sub>Made with `./explain-vid`. Narrated with ElevenLabs, rendered with HyperFrames from the diff; an overview, not a review.</sub>',
				'',
			].join('\n');
			const commentPath = `${workspace}/comment.md`;
			await harness.sandbox.writeFile(commentPath, comment);
			await harness.sandbox.writeFile(
				`${workspace}/summary.json`,
				JSON.stringify({ ...rendered, summary: data.summary, covers: data.covers }, null, 2),
			);
			return { output: { videoPath: rendered.videoPath, commentPath } };
		},
	});
}
