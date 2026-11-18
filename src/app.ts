import { createAgentRouter } from '@flue/runtime/routing';
import { bearerAuth } from 'hono/bearer-auth';
import { mount } from 'hono/mount';
import { Hono } from 'hono';
import { PrExplainer } from './agents/pr-explainer.ts';
import { githubHandler } from './channels/github.ts';
import { watchFailures } from './channels/failure-note.ts';
import { gitlabWebhook } from './channels/gitlab.ts';
import { VIDEO_ROUTE, serveObject } from './integrations/explainer-store.ts';

const app = new Hono();

// A run that dies before the agent can report it (no credits, a bad key) still
// leaves a plain note on the merge request.
watchFailures();

// The route map: every channel and custom route is mounted here explicitly.

// GitHub webhook: POST /channels/github/webhook (signature-verified by @flue/github).
// `/explain-vid` comments on pull requests dispatch to the PrExplainer agent;
// closed pull requests have their videos removed.
app.all('/channels/github/*', mount(githubHandler));

// GitLab group webhook: POST /channels/gitlab/webhook (X-Gitlab-Token checked in
// constant time). `/explain-vid` comments on merge requests dispatch to the same
// agent; closed or merged merge requests have their videos removed.
app.post('/channels/gitlab/webhook', gitlabWebhook);

// Explainer videos: GET /videos/<signature>/<key>. The signature (an HMAC of the
// key) is the authorization; it exists only in the pull-request or merge-request comment.
app.on(['GET', 'HEAD'], `${VIDEO_ROUTE}/:signature/:key{.+}`, serveObject);

// The agent is dispatch-only in normal operation (the webhook reaches it without
// HTTP). This mount exists for operators: re-run a render by hand or inspect a
// pull request's conversation. It is gated by OPERATOR_TOKEN and fails closed
// when the token is unset.
//
//   curl "https://<worker>/agents/pr-explainer/github:v1:<owner>:<repo>:<n>?view=history" \
//     -H "authorization: Bearer $OPERATOR_TOKEN"
//
// GitLab conversations use the id gitlab:v1:<project id>:<merge request iid>.
app.use('/agents/*', async (c, next) => {
	const token = process.env.OPERATOR_TOKEN;
	if (!token) return c.text('OPERATOR_TOKEN is not configured', 503);
	return bearerAuth({ token })(c, next);
});
app.route('/agents/pr-explainer', createAgentRouter(PrExplainer));

app.get('/healthz', (c) => c.text('ok'));

export default app;
