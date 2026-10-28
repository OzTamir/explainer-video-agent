# Setup

From an empty Cloudflare account to the first `/explain-vid`. Every step is run once; afterwards a
deploy is `npm run deploy` (or a push to `main` with Workers Builds, at the end of this page).

## Prerequisites

| Need | Why |
|---|---|
| Cloudflare account on the **Workers Paid** plan | Containers (the render sandbox) and the subrequest budget a long agent run needs. R2 is included. |
| `wrangler` logged in (`npx wrangler login`, check with `npx wrangler whoami`) | creating the bucket, setting secrets, deploying |
| Anthropic API key | the model (`anthropic/claude-opus-5` for the build, Haiku for compaction) |
| ElevenLabs API key with text-to-speech access | the narration |
| A GitHub account or organization that can create a GitHub App | the trigger and the comments |
| Node 22.19 or newer | Flue's requirement |
| Docker (local development only) | `npm run dev` builds the render container on your machine |

```sh
git clone <this repo> && cd explainer-video-agent
npm install
npm run check:types
```

## 1. The video bucket

Private (no public hostname, no `r2.dev`), with the week-long expiry rule the comment promises:

```sh
npx wrangler r2 bucket create explainer-videos
npx wrangler r2 bucket lifecycle add explainer-videos expire-after-7-days --expire-days 7 --force
```

The bucket name is bound in `wrangler.jsonc` → `r2_buckets[].bucket_name`; change both if you
pick another name. `RETENTION_DAYS` in `src/integrations/explainer-store.ts` is what the comment
says; keep it equal to the lifecycle rule.

## 2. The GitHub App

One App, created once, installed on whichever repositories should answer to `/explain-vid`.

1. **Create the App.** Organization → Settings → Developer settings → GitHub Apps → New GitHub App
   (or under your personal settings for a personal account).
   - Name: what the comments will be signed as (for example `PR Explainer`). Comments and
     reactions appear as `<name>[bot]`.
   - Webhook: Active. URL `https://<your-worker>/channels/github/webhook`. You can fill the URL in
     after the first deploy (step 5) if you do not know the hostname yet. Generate a secret
     (`openssl rand -hex 24`) → `GITHUB_WEBHOOK_SECRET`.
   - Repository permissions: **Pull requests: Read**, **Issues: Read and write**. (Metadata: Read
     is added automatically.) Nothing else.
   - Subscribe to events: **Issue comment** (the command) and **Pull request** (cleanup on close).
   - Where can this App be installed: *Only on this account*.
2. **Note the App ID** from the App's settings page → `GITHUB_APP_ID` (a var in `wrangler.jsonc`).
3. **Generate a private key** (same page, bottom). It downloads a `.pem` → `GITHUB_APP_PRIVATE_KEY`.
   GitHub issues it as PKCS#1 ("BEGIN RSA PRIVATE KEY"); the client converts it for WebCrypto, so
   the file goes in as downloaded.
4. **Install the App** (App settings → Install App) on the repositories to serve. The webhook starts
   delivering `issue_comment` events for those repositories; GitHub shows each delivery and the
   Worker's response under the App's Advanced tab.
5. Optionally restrict further with `GITHUB_ALLOWED_REPOS` (comma-separated `owner/repo`).

Who can trigger a render is decided per repository by GitHub: owners, members and collaborators
with write access. Nothing in this repo changes that.

## 3. ElevenLabs

An API key with text-to-speech access (elevenlabs.io → Developers → API keys). One 60-second
narration is roughly 850 characters; see the ElevenLabs pricing page for the per-character rate of
the chosen model. The default voice is the stock "Brian" voice with `eleven_multilingual_v2`; to
change the voice, pick an id from the voice library and set `ELEVENLABS_VOICE_ID`. Any model that
supports the timestamps endpoint works.

## 4. Secrets and vars

Secrets are set once per Worker and survive deploys. Secrets can be set before the Worker exists;
wrangler creates it.

```sh
for s in ANTHROPIC_API_KEY GITHUB_WEBHOOK_SECRET ELEVENLABS_API_KEY OPERATOR_TOKEN; do
  npx wrangler secret put $s
done
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/<app-name>.<date>.private-key.pem
openssl rand -hex 32 | npx wrangler secret put VIDEO_URL_SECRET   # rotating it breaks every posted video link
```

`OPERATOR_TOKEN` is any long random string; it gates the `/agents/*` mount used to run a render by
hand and read conversation history. The mount answers 503 without it, so you can leave it unset in
production if you never need the mount.

Non-secret configuration is `wrangler.jsonc` → `vars`: fill in `GITHUB_APP_ID`. `PUBLIC_BASE_URL`
is the Worker's public origin, which you learn from the first deploy; see the next step.

## 5. First deploy

```sh
npm run deploy
```

Vite builds the Worker and `wrangler deploy` uploads it, builds the container image on Cloudflare
(the first build takes a while: Chromium, fonts, FFmpeg, the HyperFrames CLI), applies the Durable
Object migration and binds the bucket. The command prints the Worker's URL
(`https://explainer-video-agent.<subdomain>.workers.dev`).

Then:

1. Put that origin in `wrangler.jsonc` → `vars.PUBLIC_BASE_URL` and deploy again. The signed video
   links are built from it.
2. Put `https://<that origin>/channels/github/webhook` in the GitHub App's webhook URL if you left
   it empty.
3. Check: `curl https://<that origin>/healthz` returns `ok`, and an unsigned
   `curl -X POST https://<that origin>/channels/github/webhook` returns a 4xx, not a 503.

To serve the Worker from your own hostname instead of `workers.dev`, set `"workers_dev": false`
and add a `routes` entry with `custom_domain: true` in `wrangler.jsonc`, then use that origin in
`PUBLIC_BASE_URL` and the webhook URL.

## 6. Try it

Open a pull request on a repository the App is installed on and comment `/explain-vid`. Within a
few seconds the comment gets an 👀; within a minute or two a progress comment appears and walks
through the stages; a few minutes later it is replaced by the video. The App's Advanced tab shows
the delivery and the Worker's `200`.

If nothing happens, [operations.md](operations.md#troubleshooting) lists the usual causes.

## Continuous deployment (optional)

Cloudflare Workers Builds can build and deploy every push to `main`. In the dashboard, under the
Worker → Settings → Builds, connect the repository with:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Non-production branch builds | off |

On every push, Cloudflare clones the repo, runs `npm clean-install`, the build, then the deploy,
including the container image. Secrets never enter the build: they stay on the Worker. Commit the
lockfile with every `package.json` change, or `npm clean-install` refuses it; the repo's `.npmrc`
pins `legacy-peer-deps=false` so the lockfile is valid regardless of a developer's global npm
config.
