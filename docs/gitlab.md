# GitLab setup

The same `/explain-vid` command for GitLab merge requests, for a whole group at once. One group
access token posts the notes, one group webhook delivers the events. GitHub does not need to be
configured; the two providers are independent and either one can be left out.

Do the shared steps in [setup.md](setup.md) first (bucket, ElevenLabs, `ANTHROPIC_API_KEY`,
`ELEVENLABS_API_KEY`, `VIDEO_URL_SECRET`, `PUBLIC_BASE_URL`). Skip its GitHub App step if you only
want GitLab.

## What you need

| Need | Why |
|---|---|
| The **Owner** role on the group | creating a group access token and a group webhook |
| GitLab.com: a **Premium or Ultimate** group. Self-managed: group access tokens work on any license, group webhooks need Premium or Ultimate | both features are paid on GitLab.com |
| The Worker's public URL | the webhook target; you get it from the first deploy |

On a Free group, see [Without a paid plan](#without-a-paid-plan) at the end.

## 1. Create the group access token

Group → **Settings → Access tokens → Add new token**.

| Field | Value |
|---|---|
| Token name | what the notes will be signed as, for example `MR Explainer` |
| Expiration date | up to 365 days from today (GitLab's default maximum). Put a reminder in a calendar. |
| Role | **Reporter** |
| Scopes | **api** only |

Copy the token; GitLab shows it once. It becomes `GITLAB_TOKEN`.

Why these two: `api` is the only scope that can write through the REST API (`read_api` cannot post
a note). Reporter is the lowest role that can read merge requests and their diffs in private
projects and comment on them. The token never pushes code, so it needs no repository scope.
Keeping the role below Developer also means the token's own bot user can never pass the trigger
check below.

GitLab creates a bot user for the token (`group_<id>_bot_<random>`). Notes and the 👀 reaction
come from it.

## 2. Set the secrets

```sh
npx wrangler secret put GITLAB_TOKEN             # paste the group access token
openssl rand -hex 24                             # copy the output, it is the webhook secret
npx wrangler secret put GITLAB_WEBHOOK_SECRET    # paste it
```

Non-secrets are in `wrangler.jsonc` → `vars`:

- `GITLAB_BASE_URL`: `https://gitlab.com`, or the origin of a self-managed instance
  (`https://gitlab.example.com`, no `/api/v4`).
- `GITLAB_ALLOWED_PROJECTS`: optional. Comma-separated project paths (`acme/api`) or group paths
  (`acme/tools` covers every project under it). Empty means every project in the group.

## 3. Deploy

```sh
npm run deploy
```

Check the route: `curl -X POST https://<your-worker>/channels/gitlab/webhook` answers `401`
(`503` means `GITLAB_WEBHOOK_SECRET` is not set yet).

## 4. Create the group webhook

Group → **Settings → Webhooks → Add new webhook**.

| Field | Value |
|---|---|
| URL | `https://<your-worker>/channels/gitlab/webhook` |
| Secret token | the value you stored as `GITLAB_WEBHOOK_SECRET` |
| Trigger | tick **Comments** and **Merge request events**; untick everything else |
| SSL verification | enabled |

Use the **Secret token** field. The newer signing token (HMAC signature) is not checked by this
Worker yet; see [security.md](security.md#known-gaps).

A group webhook fires for every project in the group and its subgroups, which is what makes one
webhook cover the whole group.

## 5. Try it

Open a merge request in any project of the group and comment `/explain-vid` (or `/explain-vid
focus on the migration`). The comment gets an 👀, a progress note appears within a minute or two,
and a few minutes later it is replaced by the video. The webhook's **Recent events** list (Edit
the webhook, scroll down) shows each delivery and the Worker's answer.

When the merge request is merged or closed, the videos are deleted and each explainer note is
rewritten to say so.

## Who can trigger a render

The comment's author needs at least the **Developer** role on the project, directly or inherited
from a group. The Worker checks this with the token on every command
(`GET /projects/:id/members/all/:user_id`). Everyone else is ignored. Notes written by the token's
own bot user and system notes are ignored too.

## What the Worker answers

Every verified delivery gets a `200` with a short reason, so the Recent events list explains
itself:

| Answer | Meaning |
|---|---|
| `dispatched` | a render started |
| `cleanup started` | the merge request closed or merged; its videos are being removed |
| `ignored: not the command` and similar | nothing to do (most deliveries) |
| `ignored: author is not a Developer or above` | the commenter may not trigger a render |
| `ignored: project not allowed` | `GITLAB_ALLOWED_PROJECTS` does not cover the project |
| `401` | the secret token does not match `GITLAB_WEBHOOK_SECRET` |
| `503` | `GITLAB_WEBHOOK_SECRET` is not set on the Worker |
| `500` | the Worker could not reach GitLab with `GITLAB_TOKEN`, or could not start the agent |

GitLab disables a webhook for a while after four failed deliveries in a row and re-enables it by
itself. After fixing the cause, **Test → Comments** on the webhook turns it back on at once.

## Rotating the token

The token expires. Before it does: create a new one (or use **Rotate** on the token),
`npx wrangler secret put GITLAB_TOKEN`, done. No deploy is needed. An expired token shows up as
`500` answers in Recent events.

## Without a paid plan

Group access tokens and group webhooks are not available on a Free GitLab.com group. The Worker
does not care where the token and the webhook come from, so this should work too:

- as `GITLAB_TOKEN`, a personal access token (scope `api`) of a dedicated user that was added to
  the group with the Reporter role;
- a **project webhook** (Project → Settings → Webhooks) on each project, with the same URL,
  secret and triggers.

This path is not tested.
