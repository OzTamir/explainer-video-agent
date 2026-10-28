# How it works

The agent is `PrExplainer` in `src/agents/pr-explainer.ts`. It is one Flue agent function: a
model, a set of tools, a container to work in, and a block of instructions. Everything that must
be true of the output (which pull request it posts to, how long the video is, what gets published)
is enforced by the tools, not by the prompt.

## Trigger

The GitHub App's webhook (`POST /channels/github/webhook`, handled in `src/channels/github.ts`)
dispatches a run for an `issue_comment` delivery that is all of:

| Check | Where |
|---|---|
| the comment is on a pull request (not an issue) | channel handler |
| the body is `/explain-vid`, alone or followed by a note (`/explain-vid focus on the migration`) | channel handler |
| the author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` (write access to that repo) | channel handler |
| the author is not a bot | channel handler |
| the repository is in `GITHUB_ALLOWED_REPOS`, when that var is set | channel handler |

Anything else gets an empty `200` and nothing happens. A matching comment gets an 👀 reaction at
once, then a progress comment from the agent within a minute or two (the container has to start).

`/explain-video` or `/explain-vids` is not the command; only `/explain-vid` alone or followed by
whitespace matches.

The note after the command reaches the model as the request ("focus on X", "keep it under
thirty seconds", "for the support team"); without one the video explains the change to an engineer
who has not read the diff.

## One conversation per pull request

The conversation id is `github:v1:<owner>:<repo>:<number>` (derived by `@flue/github`). Every
`/explain-vid` on the same pull request lands in the same conversation, so a second request can
refer to the first. The App installation id from the first delivery is recorded with the
conversation; every GitHub call for that pull request acts as that installation.

Each delivery is one *run*. The delivery id is the idempotency key, so a redelivered webhook never
renders twice, and it also keys the run's progress comment and its objects in the bucket.

## What a run does

| Stage | Tools | What happens |
|---|---|---|
| reading | `pull_request`, `pull_request_patches` | Pull request facts, every file (lockfiles, generated and binary files flagged as noise), commits with authors, and the length band for a change this size. Patches for the files that carry the change. |
| writing | `prepare_workspace`, sandbox `write` | A fresh HyperFrames project is scaffolded in `/workspace/explainer`. The model writes `SCRIPT.md` (narration, one paragraph per scene) and `SPEC.md` (the director's brief with numbers). |
| narrating | `generate_narration` | ElevenLabs text-to-speech with timestamps, called from the Worker. Writes `assets/audio/narration.mp3` and `assets/audio/words.json` (word start/end seconds) into the project. |
| building | sandbox `bash`, `write`, `edit` | One scene file per paragraph, timed to the word timings; `hyperframes lint` and `hyperframes check` until clean. |
| rendering | `render_and_publish` | Re-runs `check` as a gate, `hyperframes render --quality delivery`, verifies the file with `ffprobe`, extracts a poster frame, stores both in the bucket, returns their signed URLs. |
| done | `post_explainer_comment` | Replaces the progress comment with the final one: poster linking to the video, play link, duration, one-line summary, 2–4 bullets. Records what the cleanup needs. |

`set_status` keeps one comment per run updated through the stages; on failure it ends with a
one-line reason. The agent never posts anything else to the pull request.

### The tools, and what each one refuses

The model only acts through these tools. Each binds its destination in code; the model supplies
content and chooses arguments, never a repository, a bucket key or a credential.

| Tool | Does | Refuses |
|---|---|---|
| `pull_request` | Reads the pull request, its files and commits as the App installation. | — (read-only) |
| `pull_request_patches` | Returns unified-diff hunks for up to 12 named files, each cut at a character limit. | More than 12 files; files not in the pull request are listed back as missing. |
| `set_status` | Creates the run's progress comment on first call, edits it afterwards. | Notes longer than 240 characters. |
| `prepare_workspace` | Wipes `/workspace/explainer` and runs `hyperframes init` there. | Nothing, which is why the instructions say to call it once, before the narration exists. |
| `generate_narration` | Calls ElevenLabs, writes the audio and word timings into the project. | A script over the word ceiling; audio that runs past the narration limit (the audio is discarded and the error says how many words to cut); a seventh narration for the same pull request; running before the project is scaffolded. |
| `render_and_publish` | `hyperframes check`, render, `ffprobe`, poster frame, upload, signed URLs. | A failing check; a render that fails or produces no file; an unplayable file; a video over 60 seconds; a file over 200 MB. |
| `post_explainer_comment` | Writes the final comment and a `meta.json` next to the video. | A video URL other than the one `render_and_publish` returned in this run. |

## Length

No video runs longer than 60 seconds. Within that, the target comes from the size of the
substantive change (lockfiles, vendored and generated files excluded); a bigger change earns more
of the minute, never more than the minute:

| Changed lines | Target | Script cap |
|---|---|---|
| under 50 | 15–25 s | 50 words |
| 50–200 | 25–40 s | 80 words |
| 200–600 | 35–50 s | 100 words |
| 600+ or 25+ files | 45–60 s | 117 words |

Word caps assume two words a second, below the voice's speaking pace, so the pauses between
paragraphs fit inside the budget. The ceiling is enforced in code at three points, not by the
prompt: the narration tool refuses a script over 117 words and discards audio that runs past 58.5
seconds (the narration counts against the budget either way, and the error says how many words to
cut), and `render_and_publish` refuses a file longer than 60 seconds. A pull request gets at most 6
narrations over its lifetime (a cost guard); if none of them fit, the tool tells the agent to fail
the run rather than build without audio.

The constants (`MAX_VIDEO_SECONDS`, `END_HOLD_SECONDS`, `MAX_NARRATIONS`, the bands) sit at the
top of the relevant sections in `src/agents/pr-explainer.ts`; see
[configuration.md](configuration.md#changing-the-behavior).

## Where things run

The model works in a **Cloudflare Sandbox container** (one per pull request, keyed by the
conversation id) built from `Dockerfile`: Node 22, Chromium, FFmpeg, the HyperFrames CLI pinned to
the version its skills were written for, and the HyperFrames skills under
`/workspace/.agents/skills` (Flue discovers them as workspace skills). The container is scratch
space: every run re-scaffolds the project. It sleeps after 10 minutes idle.

ElevenLabs and GitHub are called from the Worker, never from the container, so neither key enters
the model's shell. The bucket is written only inside `render_and_publish`.

The first run after a deploy that changes the image waits for Cloudflare to place a container
instance, which can take minutes; the agent allows up to five for placement and ten for the boot.

## Output and retention

One mp4 per run (1920×1080, 30 fps, H.264 + AAC) and a poster frame, in the private
`EXPLAINER_VIDEOS` bucket under `<owner>/<repo>/pr-<number>/<delivery id>/`. The Worker serves
them itself at `/videos/<signature>/<key>`: the signature is an HMAC of the key with
`VIDEO_URL_SECRET`, checked in constant time, and the only place it is ever written is the
pull-request comment. So a video is reachable by exactly the people who can read that comment, the
bucket has no public hostname and no listing, and the poster still renders inline because GitHub's
image proxy fetches the signed URL like any other. The route supports HTTP Range, so the browser
can seek.

Two things remove a video:

- **A week** (`RETENTION_DAYS`): a lifecycle rule on the bucket expires every object after 7 days.
  The comment says so; afterwards the link answers "no longer available".
- **The pull request closing or merging**: the App's `pull_request` webhook deletes that pull
  request's objects and rewrites each run's comment to "_The video was removed when the pull
  request closed._", keeping the summary and bullets. No model turn is involved: the comment id
  and the summary are in a small `meta.json` the publish step writes next to the video.

Rotating `VIDEO_URL_SECRET` invalidates every link posted so far.

Why not attach the file to the comment directly: GitHub's comment-attachment upload (what the web
editor uses) answers 404 to App installation tokens, so the video is served from the bucket
instead.

## HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /channels/github/webhook` | GitHub webhook signature | the App's deliveries |
| `GET\|HEAD /videos/<signature>/<key>` | the signature in the URL | serves a video or poster |
| `/agents/pr-explainer/*` | bearer `OPERATOR_TOKEN` | run a render by hand, read a conversation ([local-development.md](local-development.md#run-a-render-by-hand)) |
| `GET /healthz` | none | `ok` |

There is no other route.
