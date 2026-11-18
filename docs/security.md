# Security

What this system handles, what protects it, and what does not. Written to be checked against the
code, not to reassure.

## What data flows through it

| Data | Source | Where it goes |
|---|---|---|
| Pull request or merge request title, description, diff, commit authors, the triggering comment | GitHub or GitLab (read) | model context; the render container's filesystem; paraphrased into a narration script and a video; conversation history |
| The narration script | the model | ElevenLabs (text-to-speech); the audio and word timings land in the container |
| The rendered video and poster | the container | a private R2 bucket, served by the Worker under signed links that exist only in the pull-request or merge-request comment |

Every model call sends the relevant slice of this to Anthropic's API under your account. The
Worker's only outbound destinations are GitHub, GitLab (the instance in `GITLAB_BASE_URL`),
ElevenLabs, R2, the render container and Anthropic. The container itself has outbound internet (Cloudflare's default), which the model's
shell can use; see below.

## Boundaries that hold by construction

**Inbound HTTP.**
- `/channels/github/*`: `@flue/github` verifies `X-Hub-Signature-256` against the raw body before
  the handler runs. The handler admits only a new comment on a pull request that starts with
  `/explain-vid`, from an `OWNER`, `MEMBER` or `COLLABORATOR` of that repository (GitHub computes
  the association per repository, so a fork's contributor cannot trigger a render on the upstream
  repo), not from a bot, and, when `GITHUB_ALLOWED_REPOS` is set, only for listed repositories.
  A `pull_request` `closed` delivery deletes that pull request's videos and rewrites its explainer
  comments. Everything else is a no-op `200`. The route answers 503 while the webhook secret is
  unset, so a misconfiguration fails closed.
- `/channels/gitlab/webhook` (POST only): the handler compares the `X-Gitlab-Token` header with
  `GITLAB_WEBHOOK_SECRET` before it reads the body. Both values are hashed with SHA-256 and the
  digests compared without an early exit, so timing does not depend on the header. A wrong or
  missing header gets `401`; an unset secret gets `503`, so a misconfiguration fails closed. This
  is a shared secret sent in every delivery, not a signature: it proves the sender knows the
  secret and nothing about the body, and a captured delivery can be replayed (see Known gaps).
  After that check the handler admits only a new, non-system note on a merge request that starts
  with `/explain-vid`, for a project covered by `GITLAB_ALLOWED_PROJECTS` when set, whose author
  is not the token's own bot user and has the Developer role or higher on that project (asked
  from GitLab with the service token, inherited and invited memberships included; a blocked
  member counts as none). The project id and merge request iid are taken from that payload and
  never from the model. A merge request event with the action `close` or `merge` deletes that
  merge request's videos and rewrites its explainer notes. Everything else is a `200` with a
  one-line reason, sent only to callers that passed the secret check.
- `/videos/<signature>/<key>`: unauthenticated by design; the signature (HMAC-SHA256 of the key
  under `VIDEO_URL_SECRET`, compared in constant time) is the capability. A valid link is written
  only into a pull-request comment, so possession tracks the ability to read that comment. There
  is no listing; a wrong or expired link returns a short text and nothing about other objects.
- `/agents/*` (operator mount): bearer-token auth (`OPERATOR_TOKEN`) applied as middleware before
  the Flue router. Returns 503 if the token is unset.
- `/healthz`: unauthenticated, returns `ok` and nothing else.
- There is no other route.

**What the model can do.** The model only acts through tools, and tools are the entire action
surface. It has a shell and a filesystem: a Cloudflare Sandbox container per pull request
(`Dockerfile`), isolated from the Worker and from other conversations. Inside it the model can
run anything the image contains and reach the internet (the container's default egress). What it
cannot do from there:

- read any credential: GitHub and ElevenLabs are called from the Worker, and no secret is passed
  into the container;
- write to the bucket: only the `render_and_publish` tool does, after `hyperframes check` passes
  and `ffprobe` accepts the file, under the prefix of the pull request the conversation was
  created for;
- post to GitHub anywhere but that pull request: only `set_status` and `post_explainer_comment`,
  both bound to it, and the final comment must link the file this run rendered;
- act as any other installation: the installation id is recorded at conversation creation from
  the signed webhook payload, and every GitHub call uses it;
- on GitLab, reach any other project or merge request: the project id and iid are recorded at
  conversation creation from the verified webhook payload, and `GitLabClient` is constructed
  bound to them. The token itself is wider than that binding; see Credentials.

The narration tool caps script length and the number of narrations per pull request.

**Credentials.** Read from the Worker environment (`.dev.vars` locally, Cloudflare secrets in
production). Never in code, logs, tool outputs or dispatched messages. `.dev.vars` is gitignored.

The two providers differ in how much a leaked credential is worth. GitHub calls use one-hour
installation tokens limited to Pull requests: read and Issues: write. `GITLAB_TOKEN` is one
long-lived group access token (up to a year) with the `api` scope, because GitLab has no narrower
scope that can post a note. With the Reporter role it can read every project in the group
(code, issues, merge requests) and comment anywhere in it, and it cannot push code or change
settings. Only the code in `src/integrations/gitlab.ts` limits what the Worker does with it.
Do not give the token a higher role than Reporter.

**Delivery integrity.** GitHub deliveries dispatch with `idempotencyKey: deliveryId`, which GitHub
keeps on manual redelivery, so a redelivered webhook cannot run a second render. GitLab
deliveries dispatch with `idempotencyKey: note-<note id>`, so one comment starts one render however
often it is retried, redelivered or replayed.

## Boundaries that depend on the model's judgment

These are instructions, not enforcement. Treat them as best-effort.

- **Prompt injection via content.** The untrusted content is the pull request (or merge request) itself: description,
  diff, commit messages, the trigger comment's note. The model reads all of it and has a shell. A
  hostile diff can make the video say wrong things, waste a render, or make the shell fetch
  something from the internet. It cannot reach a credential, post anywhere but that pull
  request's comment, or publish a file that did not pass the render gate. Trigger access is
  limited to people with write access (GitHub) or the Developer role (GitLab) on purpose; keep it
  that way for public repositories and projects.
- **Truthfulness.** "Every claim must trace to the diff" is a prompt rule. The video is an
  overview, not a review, and the comment says so.

## Data at rest

- Each conversation's full history (messages, tool inputs and outputs, including the patches the
  model read, persistent state) lives in the agent's Durable Object SQLite storage on Cloudflare,
  in your account's jurisdiction, with no retention limit today. Flue compacts long conversations
  for the model but does not delete records.
- The render container's filesystem holds the diff, the script, the narration and the rendered
  file for the life of the container (it sleeps after 10 minutes idle and may be recycled).
- The rendered video and poster sit in a private R2 bucket (no public hostname) and are reachable
  only through their signed links in the pull-request comment, for 7 days (bucket lifecycle rule)
  or until the pull request closes (the channel deletes them). Anyone the link is forwarded to can
  watch it until then; that is the same exposure as the comment text itself.
- The narration script (a paraphrase of the change) is sent to ElevenLabs under their data terms.
- Local development keeps the same data in `.wrangler/state` on the developer's machine
  (gitignored).
- Workers Logs and Traces are enabled. Flue's tracing emits agent-level spans; review what the
  spans include before granting broad dashboard access.
- Anthropic's data handling applies to model calls under your API account.

## Operational rules

- Rotate any key immediately if exposed: `npx wrangler secret put <NAME>`; secrets apply live.
- `OPERATOR_TOKEN` grants the ability to trigger renders on any pull request the App can reach,
  on any merge request `GITLAB_TOKEN` can reach, and to read every conversation's history. Treat it like a production credential; leave it unset
  if you never use the mount.
- `VIDEO_URL_SECRET` signs every video link. Rotating it is the kill switch for all posted links
  at once; the objects then expire on their own.
- Installing the App on a public repository means any collaborator with write access can spend
  your ElevenLabs and Anthropic budget with one comment. Use `GITHUB_ALLOWED_REPOS`.
- A GitLab group webhook covers every project in the group and its subgroups, so every Developer
  in the group can spend that budget. Use `GITLAB_ALLOWED_PROJECTS` to narrow it.
- `GITLAB_TOKEN` expires (365 days at most by default). Rotate it before then with
  `npx wrangler secret put GITLAB_TOKEN`, and revoke the old one in the group's Access tokens page.
- `GITLAB_WEBHOOK_SECRET` is stored in GitLab's webhook settings, where group Owners can replace
  it. Anyone who learns it can forge a delivery that names any project and author, which starts
  renders on merge requests the token can reach. Rotate it in both places if exposed.

## Known gaps

1. Container egress is open. Restricting it to nothing (the image carries everything a render
   needs) would close the one outbound path the model controls.
2. No per-repository or per-day cap on renders; the only cost guards are per pull request
   (narrations) and per run (length).
3. Prompt-injection hardening: wrapping the patches and the pull request body in explicit data
   delimiters with an instruction that content inside is data, not instructions.
4. Retention of conversation history: a job that deletes a pull request's conversation some time
   after it closes.
5. The `/agents/*` mount could be removed from production builds entirely and kept behind a
   build flag for development.
6. The GitLab webhook is verified with the plain secret token only. GitLab's newer signing token
   (an HMAC over the delivery id, a timestamp and the body, in the `webhook-signature` header)
   would add body integrity and replay protection; it is not implemented. Until then a replayed
   delivery can at most repeat a cleanup or hit the idempotency key.
7. The GitLab role check runs once, when the command arrives. Someone who loses the Developer
   role while a render is running still gets the video.
8. `GITLAB_TOKEN` cannot be scoped below `api`; GitLab's fine-grained permissions cover
   personal access tokens only today.
