# Local CLI: `./explain-vid`

The same explainer without the GitHub App, the Worker, the container or the bucket. It reads the
pull request with your `gh` login, runs the agent on your machine and leaves the video on disk.
Use it when you can't install an App, for a one-off, or to iterate on the prompt and the scenes
without deploying anything.

```sh
./explain-vid https://github.com/<owner>/<repo>/pull/<n>
./explain-vid <owner>/<repo>#<n> --note "focus on the migration"
./explain-vid <pr-link> --comment          # also post the summary on the PR
```

The result lands in `out/<owner>/<repo>/pr-<n>/` (gitignored):

| File | What it is |
|---|---|
| `explainer.mp4` | the 1080p video, one minute at most |
| `poster.jpg` | a frame from the start |
| `comment.md` | the summary and what the video covers; what `--comment` posts |
| `summary.json` | duration, size, summary and bullets, for scripts |
| `explainer/` | the HyperFrames project (script, spec, scenes, narration); open it with `npx hyperframes preview` |

## Requirements

- `gh`, logged in (`gh auth login`) with read access to the repository. `--comment` also needs
  permission to comment on it.
- Node 22.19+ and `npm install` in this repository. That installs the HyperFrames CLI pinned to
  the version the container uses.
- `ffmpeg` and `ffprobe` (`brew install ffmpeg`). Chrome for rendering is fetched by
  `hyperframes browser ensure` on the first run.
- `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY`, from the shell, `.env` or `.dev.vars`, in that
  order. Nothing else from `.dev.vars.example` is needed. `ELEVENLABS_VOICE_ID` and
  `ELEVENLABS_MODEL_ID` are honored when set.

`npx hyperframes doctor` checks the toolchain. Its optional items (whisper, Kokoro, MusicGen)
are not used.

## How it differs from the App

The agent is `cli/pr-explainer-local.ts`, run once through `flue run`. It shares the steps, the
length budgets, the narration tool and the render gate with the Worker agent through
`src/explainer/core.ts`, so the two make the same video. The differences:

| | GitHub App (Worker) | `./explain-vid` |
|---|---|---|
| Trigger | `/explain-vid` comment from a writer | you, on the command line |
| Reads the PR as | the App installation | your `gh` login (`gh api`) |
| Model's shell | a Cloudflare container per PR | **your machine**, in the workspace directory |
| Progress | an edited PR comment | the terminal |
| Output | R2 + signed link in a PR comment | files under `out/` |
| Posting | always | only with `--comment`, done by the script with `gh pr comment` after a successful run |
| Narration cap | 6 per pull request | 3 per run |

GitHub's API cannot attach a video to a comment. After `--comment`, edit the comment on GitHub and
drop `explainer.mp4` into it. GitHub's upload limit applies (10 MB on free plans, 100 MB on paid).

Each run is a fresh conversation, stored in `node_modules/.cache/flue/run.db`. A re-run for the
same PR reuses the workspace directory: the agent re-scaffolds the project and the script
deletes the previous video first.

## Cost and safety

Every run is real: it spends Anthropic and ElevenLabs credits. The model's shell runs on your
machine **as you**, with no isolation. Read [security.md](security.md#local-cli-explain-vid)
before you point it at pull requests from people you don't trust.
