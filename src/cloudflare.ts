// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

// The container-backed sandbox the PrExplainer agent renders in. Cloudflare
// needs the Durable Object class exported from the Worker entry; its binding,
// container image and migration are in wrangler.jsonc.
export { Sandbox } from '@cloudflare/sandbox';
