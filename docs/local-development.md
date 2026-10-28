# Local development

The Worker runs locally in workerd through Vite and the Cloudflare plugin. It behaves like
production with two exceptions: GitHub cannot reach `localhost` without a tunnel, and the render
container runs on your Docker daemon (the dev server builds `Dockerfile` on start; the first build
takes several minutes, later ones are cached). The video bucket is simulated locally and the
Worker serves the files itself, so with `PUBLIC_BASE_URL="http://localhost:5173"` in `.dev.vars`
the links a dev run posts work from your machine (and from nowhere else).

Every run is real, locally or not: it comments on the pull request and spends ElevenLabs credits.
Use a test repository.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars    # fill every value; see docs/setup.md for where each comes from
```

`.dev.vars` is read by `npm run dev` only and is gitignored. Non-secret vars in `wrangler.jsonc`
are overridden by the same names in `.dev.vars`.

## Run

```sh
npm run check:types   # fast feedback; must pass before committing
npm run dev           # http://localhost:5173 (Docker must be running)
curl http://localhost:5173/healthz
```

File edits hot-reload the Worker. A reload in the middle of an agent run interrupts it; Flue
retries the interrupted tool batch. Make edits between runs.

Local Durable Object storage lives in `.wrangler/state` and is separate from production.

## GitHub against the dev server

GitHub needs a public HTTPS URL:

```sh
cloudflared tunnel --url http://localhost:5173     # or: ngrok http 5173
```

Point a GitHub App's webhook at the tunnel host plus `/channels/github/webhook` with the secret
from `.dev.vars`, install it on a test repository, and comment `/explain-vid` on a pull request
there. Quick tunnels change hostname on every start. Keep a separate App for development so the
production App's webhook URL stays untouched.

## Run a render by hand

The operator mount (bearer `OPERATOR_TOKEN` from `.dev.vars`) dispatches a run without a webhook.
It works the same way against production with the production hostname and token.

```sh
HOST=http://localhost:5173
curl -X POST "$HOST/agents/pr-explainer/github:v1:<owner>:<repo>:<n>" \
  -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"initialData":{"owner":"<owner>","repo":"<repo>","number":<n>,"installationId":<installation id>,"title":"…","openedBy":"<login>"},
       "kind":"signal","type":"github.explain_vid","body":"Explain this pull request.",
       "attributes":{"deliveryId":"manual-1","sender":"<login>","commentId":"","commentUrl":"","request":""}}'
```

`installationId` is the App's installation on that repository (App settings → Install App → the
installation's URL ends with it). The response is `202` with a `submissionId`; the agent runs in
the background. `deliveryId` keys the run's progress comment and its objects; reuse one to keep
editing the same comment, change it for a new run. `request` is the note that would follow the
command.

Read the run back:

```sh
curl "$HOST/agents/pr-explainer/github:v1:<owner>:<repo>:<n>?view=history" \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  | jq '.messages[].parts[] | select(.type=="dynamic-tool") | {toolName, state}'
```

The container's own output (`hyperframes` lint, check and render logs) shows up in the history as
tool results.

Abort a run: `POST $HOST/agents/pr-explainer/github:v1:<owner>:<repo>:<n>/abort`.

## Useful references

- `npx flue docs search <query>` / `npx flue docs read <path>`: framework docs for the installed
  version, offline. Start with `guide/building-agents`, `guide/sandboxes`, `guide/cloudflare-target`.
- `npx wrangler deploy --dry-run`: validates `wrangler.jsonc` and lists bindings without deploying.
- `docker build --platform linux/amd64 .`: builds the render image the way Cloudflare will.
