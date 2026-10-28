# Operations

## Deploy

`npm run deploy` = `vite build && wrangler deploy`, from a machine with `wrangler` logged in
(`npx wrangler whoami`), or a push to `main` with Workers Builds connected
([setup.md](setup.md#continuous-deployment-optional)).

- Vite builds the Worker into `dist/` with Flue's generated entry (one Durable Object class per
  agent) and a merged `wrangler.json`. The authored `wrangler.jsonc` is never rewritten.
- `wrangler deploy` uploads the script, builds and rolls out the container image, applies Durable
  Object migrations and binds the bucket. A manual deploy needs a running Docker daemon for the
  image; Workers Builds builds it on Cloudflare.
- Secrets are set once with `npx wrangler secret put <NAME>` and apply live; a deploy does not
  touch them.

Cloudflare evaluates the module at upload. Anything that throws at import time (a client that
reads a missing secret at module scope) fails the deploy with a validation error. Construct
lazily; everything in this repo does.

## Verify a deploy

```sh
npx wrangler deploy --dry-run                                  # config + bindings, no upload
curl https://<your-worker>/healthz                             # 200 ok
curl -X POST https://<your-worker>/channels/github/webhook     # 503 until the webhook secret exists, 4xx after
```

Then comment `/explain-vid` on a pull request in a test repository, or dispatch a run by hand
through the operator mount ([local-development.md](local-development.md#run-a-render-by-hand))
and read the history back.

## Rollback

`npx wrangler rollback` returns to the previous upload. Durable Object storage is not rolled
back; conversations keep their state. Objects in the bucket are untouched.

## Updating the render image

`Dockerfile` pins two things that must move together with the code:

- `HYPERFRAMES_VERSION`, with the skills the agent's instructions were written against. After a
  bump, read the new skills (`hyperframes`, `hyperframes-cli`, `media-use`) and check the
  instructions still match their contract.
- `SANDBOX_VERSION` and the `docker.io/cloudflare/sandbox:<tag>` image, with `@cloudflare/sandbox`
  in `package.json`. The SDK refuses a mismatch at run time.

Build it locally before deploying: `docker build --platform linux/amd64 .` (Cloudflare containers
are amd64). When the SDK package and the image tag change together, deploy with
`npx wrangler deploy --containers-rollout=immediate` so the Worker and the image cut over at once.
After any deploy that changes the image, the first run waits for Cloudflare to place an instance
(minutes); the agent allows up to five.

## Observability

Workers Logs and Traces are enabled (`observability.traces` in `wrangler.jsonc`). Each agent
response appears as one trace with agent-level spans in the Cloudflare dashboard. Conversation
history (every tool call with its input and output, including the container's logs) is readable
through the operator mount with `?view=history`. The GitHub App's Advanced tab shows every
delivery and the Worker's response to it.

## Troubleshooting

**Nothing happens after `/explain-vid`.** In order: the App's Advanced tab shows the delivery
(if not, the App is not installed on that repository or the webhook URL is wrong); the response is
`200` (a `503` means `GITHUB_WEBHOOK_SECRET` is unset, a `401` that it does not match); the
commenter is an owner, member or collaborator (anyone else is ignored by design); the repository
passes `GITHUB_ALLOWED_REPOS` if set; the comment is exactly `/explain-vid` or `/explain-vid
<note>`.

**👀 appears but no progress comment.** The agent started but the first tool call failed, or the
container is still being placed. Read the conversation history through the operator mount. A
"GitHub App installation token failed" error means `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` is
wrong or the App is not installed on the repository. A container timeout on the first run after a
deploy is normal; the next run finds the instance warm.

**The progress comment ends in "Could not finish".** The note says why. The usual causes: ElevenLabs
rejected the key or the model does not support timestamps; the narration never fit under the limit
after six attempts; `hyperframes check` kept failing. The history shows the full tool errors.

**"Too many subrequests" or "Connection error" in the history.** The run exhausted the Worker's
per-invocation subrequest budget. Check that `SANDBOX_TRANSPORT` is `rpc` (every container call
would otherwise be one subrequest) and that the account is on Workers Paid.

**Chromium out of memory during render.** Raise `containers[].instance_type` in `wrangler.jsonc`;
`standard-3` is the smallest that renders 1080p comfortably.

**Video links answer "no longer available".** The object expired (7 days), the pull request
closed, or `VIDEO_URL_SECRET` was rotated. A link that answers "Not found." was never valid.

**Workers Builds fails on `npm clean-install`.** The lockfile is out of sync with `package.json`;
commit both together. The repo `.npmrc` keeps `legacy-peer-deps=false` so local installs produce
a lockfile CI accepts.

**Deploy fails with a migration error.** The `migrations` list in `wrangler.jsonc` references a
class the Worker no longer exports, or an entry was edited. Append new tags; never rewrite
deployed ones. Renaming the agent function is a `renamed_classes` migration.
