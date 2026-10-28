# AGENTS.md

How to work in this repo. Humans and coding agents alike: read this first.

## What this is

One Flue project → one Cloudflare Worker. `src/agents/pr-explainer.ts` is marked `'use agent'`
and exports the `PrExplainer` agent function; Flue turns it into a Durable Object class
(`FluePrExplainerAgent`) with its own conversations and persistent state. Everything else is plain
TypeScript the agent imports.

```
src/agents/pr-explainer.ts   the agent: instructions, tools, limits
src/channels/github.ts       verified inbound webhook (GitHub App); dispatches runs, cleans up on close
src/integrations/            fetch-based clients: github.ts, elevenlabs.ts, explainer-store.ts, env.ts
src/app.ts                   HTTP route map — every route is mounted here, explicitly
src/cloudflare.ts            exports the Sandbox container class
Dockerfile                   the render container (HyperFrames CLI, Chromium, FFmpeg)
wrangler.jsonc               Worker config: vars, container, bucket, migrations
docs/                        how-it-works, setup, configuration, local-development, operations, security
```

## Conventions

- **Prompts bend, code does not.** Prefer a tool that renders output or a guard that throws over
  a sentence in the instructions.
- **Bind destinations in code.** The model chooses arguments, never the repository, the bucket key
  or a credential. Tool outputs must be JSON (use `type`, not `interface`).
- **No Node-only APIs, no child processes** in the Worker; it runs in workerd. Shell work happens
  in the container through the sandbox.
- **Secrets** come from the environment only. Never commit, print or invent one. New variables go
  in `.dev.vars.example` (with a comment on where to get them) and, for non-secrets, `wrangler.jsonc`.
- **Fail lazily.** Cloudflare evaluates the module at upload, before secrets exist; nothing may
  throw at import time.
- `npm run check:types` must pass before every commit.
- Any change to inbound routes, tool surfaces, credentials or where data is stored updates
  `docs/security.md` in the same commit.
- **Never start `npm run dev` on the user's behalf**; it builds a container and every run is real.
  Ask for logs instead.

## Git

- Branch per change, off `main`, named Conventional-Commits style (`feat/...`, `fix/...`, `docs/...`).
- Conventional Commits for every message: `type(scope): summary` in the imperative, body
  explaining *why*. Scopes: `agent`, `github`, `elevenlabs`, `store`, `container`, `docs`.
- One self-contained change per commit, each leaving the build green.
- **No `Co-Authored-By` trailers** or other AI attribution lines in commits or PRs.
- Commit and push only when asked.
