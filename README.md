# explainer-video-agent

Comment `/explain-vid` on a pull request and get back a short narrated video that explains the
change: what it is for, how it works on the real hunks, what the diff adds and removes, and where
to start reviewing.

The agent reads the pull request through the GitHub API, writes a script, narrates it with
[ElevenLabs](https://elevenlabs.io) (with per-word timestamps, so every cut lands on a spoken
word), builds the scenes with [HyperFrames](https://hyperframes.dev) inside a container, renders
a 1080p mp4, and posts it back on the pull request. Nothing runs longer than a minute. The video
is stored privately and linked with a signed URL that exists only in that comment, for seven days
or until the pull request closes.

It is one [Flue](https://flueframework.com) agent deployed as a single Cloudflare Worker, with a
Cloudflare Sandbox container for the render and an R2 bucket for the output. It runs as a GitHub
App: the App's webhook triggers it, and its comments are posted as the App.

```
/explain-vid                              # explain the change to an engineer who has not read the diff
/explain-vid focus on the migration       # a note steers the script: a focus, a length, an audience
```

Only owners, members and collaborators of the repository can trigger a render; everyone else is
ignored.

## How a run looks

1. 👀 reaction on the command, then one progress comment that is edited through the stages:
   reading → writing → narrating → building → rendering.
2. The progress comment is replaced by the final one: a poster frame linking to the video, the
   duration, a one-sentence summary and two to four bullets of what the video covers.
3. When the pull request closes, the video is deleted and the comment is rewritten to say so.

## Setup in short

You need a Cloudflare account on the Workers Paid plan (containers), an Anthropic API key, an
ElevenLabs API key, Node 22.19+, and Docker for local development.

```sh
git clone <this repo> && cd explainer-video-agent
npm install
npm run check:types
```

Then, in order (each step is spelled out in [docs/setup.md](docs/setup.md)):

1. Create the private R2 bucket with a 7-day expiry rule.
2. Create a GitHub App (Pull requests: read, Issues: write; events: Issue comment, Pull request)
   and install it on the repositories that should answer to `/explain-vid`.
3. Set the secrets with `wrangler secret put` and the non-secret vars in `wrangler.jsonc`.
4. `npm run deploy`, point the App's webhook at `https://<your-worker>/channels/github/webhook`,
   and comment `/explain-vid` on a pull request.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/how-it-works.md](docs/how-it-works.md) | The trigger, the stages of a run, the tools the model has, length limits, where things run, output and retention. |
| [docs/setup.md](docs/setup.md) | Step-by-step setup: bucket, GitHub App, ElevenLabs, secrets, first deploy, continuous deployment. |
| [docs/configuration.md](docs/configuration.md) | Every variable and binding, the cost knobs, and how to change the agent's behavior. |
| [docs/local-development.md](docs/local-development.md) | The dev server, running a render by hand, tunnels for the webhook, reading a run back. |
| [docs/operations.md](docs/operations.md) | Deploying, verifying, rolling back, updating the render image, troubleshooting. |
| [docs/security.md](docs/security.md) | What data flows where, what is enforced by code, what depends on the model, known gaps. |

## Repository map

```
src/agents/pr-explainer.ts     the agent: instructions, tools, limits
src/channels/github.ts         the GitHub App webhook: command parsing, access checks, cleanup on close
src/integrations/github.ts     GitHub REST client authenticated as the App installation
src/integrations/elevenlabs.ts text-to-speech with per-word timings
src/integrations/explainer-store.ts   the private bucket and the signed /videos/... route
src/app.ts                     HTTP route map
src/cloudflare.ts              exports the Sandbox Durable Object class
Dockerfile                     the render container: HyperFrames CLI, Chromium, FFmpeg, fonts
wrangler.jsonc                 Worker config: vars, container, bucket, migrations
docs/                          everything above in detail
```

## License

[MIT](LICENSE).
