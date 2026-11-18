# explainer-video-agent

Comment `/explain-vid` on a GitHub pull request or a GitLab merge request and get back a short narrated video that explains the
change: what it is for, how it works on the real hunks, what the diff adds and removes, and where
to start reviewing.

The agent reads the pull request through the GitHub API (or the merge request through the GitLab
API), writes a script, narrates it with
[ElevenLabs](https://elevenlabs.io) (with per-word timestamps, so every cut lands on a spoken
word), builds the scenes with [HyperFrames](https://hyperframes.dev) inside a container, renders
a 1080p mp4, and posts it back on the pull request. Nothing runs longer than a minute. The video
is stored privately and linked with a signed URL that exists only in that comment, for seven days
or until the pull request closes.

> **GitLab support added in this fork.** This is a fork of
> [OzTamir/explainer-video-agent](https://github.com/OzTamir/explainer-video-agent) by Oz Tamir,
> who designed and built the agent, the render pipeline and the GitHub App flow. The fork adds a
> GitLab group webhook and client so the same agent serves merge requests; the GitHub path works
> as before. Setup for GitLab is in [docs/gitlab.md](docs/gitlab.md).

## Architecture

PrExplainer agent is one [Flue](https://flueframework.com) agent deployed as a single Cloudflare Worker, with a
Cloudflare Sandbox container for the render and an R2 bucket for the output. On GitHub it runs as
a GitHub App: the App's webhook triggers it, and its comments are posted as the App. On GitLab a
group webhook triggers it for every project in the group, and its notes are posted with a group
access token. Either provider can be configured alone.

```
/explain-vid                              # explain the change to an engineer who has not read the diff
/explain-vid focus on the migration       # a note steers the script: a focus, a length, an audience
```

On GitHub, only owners, members and collaborators of the repository can trigger a render. On
GitLab, only people with at least the Developer role on the project can. Everyone else is ignored.

## Setup

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

For GitLab, replace step 2 with a group access token (Reporter role, `api` scope) and a group
webhook (Comments, Merge request events) pointed at `https://<your-worker>/channels/gitlab/webhook`;
[docs/gitlab.md](docs/gitlab.md) walks through it.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/how-it-works.md](docs/how-it-works.md) | The trigger, the stages of a run, the tools the model has, length limits, where things run, output and retention. |
| [docs/setup.md](docs/setup.md) | Step-by-step setup: bucket, GitHub App, ElevenLabs, secrets, first deploy, continuous deployment. |
| [docs/gitlab.md](docs/gitlab.md) | GitLab from zero: group access token, group webhook, secrets, who can trigger, token rotation. |
| [docs/configuration.md](docs/configuration.md) | Every variable and binding, the cost knobs, and how to change the agent's behavior. |
| [docs/local-development.md](docs/local-development.md) | The dev server, running a render by hand, tunnels for the webhook, reading a run back. |
| [docs/operations.md](docs/operations.md) | Deploying, verifying, rolling back, updating the render image, troubleshooting. |
| [docs/security.md](docs/security.md) | What data flows where, what is enforced by code, what depends on the model, known gaps. |

## License

[MIT](LICENSE), © 2026 Oz Tamir. The license and copyright of the original project are unchanged.
