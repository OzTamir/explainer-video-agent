/**
 * Where rendered explainer videos live and how they are served.
 *
 * Objects sit in a private R2 bucket (`EXPLAINER_VIDEOS`). The Worker serves
 * them itself under capability URLs: `/videos/<signature>/<key>`, where the
 * signature is an HMAC of the key with `VIDEO_URL_SECRET`. The only place a
 * signature is ever written is the pull-request comment, so a video is
 * reachable by exactly the people who can read that comment, and deleting
 * the object revokes the link. Retention: a bucket lifecycle rule expires
 * objects after a week, and the GitHub channel deletes a pull request's
 * objects when it is closed.
 */
import type { Context } from 'hono';
import { env } from 'cloudflare:workers';
import { requireEnv } from './env.ts';

export const VIDEO_ROUTE = '/videos';
/** What the comment promises; matches the bucket's lifecycle rule (docs/setup.md). */
export const RETENTION_DAYS = 7;

type Bindings = { EXPLAINER_VIDEOS: R2Bucket };
const bucket = () => (env as unknown as Bindings).EXPLAINER_VIDEOS;

/** Object key prefix for one pull request; everything under it belongs to that PR. */
export function pullRequestPrefix(ref: { owner: string; repo: string; number: number }): string {
	return `${ref.owner}/${ref.repo}/pr-${ref.number}/`;
}

/** What the channel needs to tidy up a run's comment without a model turn. */
export type RunMeta = {
	commentId: number;
	summary: string;
	covers: string[];
	requestedBy: string;
	publishedAt: string;
};

export async function putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
	await bucket().put(key, bytes, { httpMetadata: { contentType, cacheControl: 'private, max-age=86400' } });
}

export async function putRunMeta(runPrefix: string, meta: RunMeta): Promise<void> {
	await bucket().put(`${runPrefix}meta.json`, JSON.stringify(meta), {
		httpMetadata: { contentType: 'application/json' },
	});
}

/** Every run under a pull request that has a meta record, oldest first. */
export async function listRuns(prefix: string): Promise<Array<{ runPrefix: string; meta: RunMeta }>> {
	const runs: Array<{ runPrefix: string; meta: RunMeta }> = [];
	let cursor: string | undefined;
	do {
		const page = await bucket().list({ prefix, cursor });
		for (const object of page.objects) {
			if (!object.key.endsWith('/meta.json')) continue;
			const body = await bucket().get(object.key);
			if (!body) continue;
			runs.push({
				runPrefix: object.key.slice(0, -'meta.json'.length),
				meta: (await body.json()) as RunMeta,
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return runs.sort((a, b) => a.meta.publishedAt.localeCompare(b.meta.publishedAt));
}

/** Deletes everything under a prefix; returns how many objects went. */
export async function deletePrefix(prefix: string): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket().list({ prefix, cursor });
		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			await bucket().delete(keys);
			deleted += keys.length;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return deleted;
}

/** The capability URL for an object: the Worker's origin, the route, the signature, the key. */
export async function objectUrl(key: string): Promise<string> {
	const base = requireEnv('PUBLIC_BASE_URL').replace(/\/+$/, '');
	return `${base}${VIDEO_ROUTE}/${await sign(key)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

let hmacKey: Promise<CryptoKey> | undefined;

async function sign(key: string): Promise<string> {
	hmacKey ??= crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(requireEnv('VIDEO_URL_SECRET')),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', await hmacKey, new TextEncoder().encode(key));
	return base64url(new Uint8Array(mac));
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.byteLength !== bb.byteLength) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

/**
 * Hono handler for `GET|HEAD /videos/:signature/:key{.+}`. Verifies the
 * signature, then streams the object with HTTP Range support so browsers can
 * seek. Unsigned or expired links get a plain-text answer and nothing else.
 */
export async function serveObject(c: Context): Promise<Response> {
	const signature = c.req.param('signature') ?? '';
	const key = c.req.param('key') ?? '';
	if (!key || !timingSafeEqual(signature, await sign(key))) {
		return c.text('Not found.', 404);
	}

	const gone = () =>
		c.text(
			`This explainer video is no longer available (videos are kept ${RETENTION_DAYS} days or until the pull request closes).`,
			404,
		);

	const range = c.req.method === 'GET' ? parseRange(c.req.header('range')) : undefined;
	let object: R2Object | R2ObjectBody | null;
	let resolved: ResolvedRange | undefined;
	if (c.req.method === 'HEAD') {
		object = await bucket().head(key);
	} else if (range) {
		// R2 throws (InvalidRange, 10039) for a range it cannot satisfy, so clamp
		// against the object's size before asking for the bytes.
		const head = await bucket().head(key);
		if (!head) return gone();
		resolved = resolveRange(range, head.size);
		if (!resolved) {
			return c.text('Range not satisfiable.', 416, { 'content-range': `bytes */${head.size}` });
		}
		object = await bucket().get(key, {
			range: { offset: resolved.start, length: resolved.end - resolved.start + 1 },
		});
	} else {
		object = await bucket().get(key);
	}
	if (!object) return gone();

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('accept-ranges', 'bytes');
	headers.set('etag', object.httpEtag);
	headers.set('x-content-type-options', 'nosniff');
	headers.set('content-disposition', 'inline');

	const body: ReadableStream | null = 'body' in object ? (object as R2ObjectBody).body : null;
	if (resolved && body) {
		const { start, end } = resolved;
		headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
		headers.set('content-length', String(end - start + 1));
		return new Response(body, { status: 206, headers });
	}
	headers.set('content-length', String(object.size));
	return new Response(body, { status: 200, headers });
}

type Range = { offset: number; length?: number } | { suffix: number };

function parseRange(header: string | undefined): Range | undefined {
	const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return undefined;
	const [, startText, endText] = match;
	if (startText) {
		const offset = Number(startText);
		return endText ? { offset, length: Number(endText) - offset + 1 } : { offset };
	}
	if (endText) return { suffix: Number(endText) };
	return undefined;
}

type ResolvedRange = { start: number; end: number };

/** Clamps a parsed range to the object; `undefined` means 416. */
function resolveRange(range: Range, size: number): ResolvedRange | undefined {
	if (size === 0) return undefined;
	if ('suffix' in range) {
		if (range.suffix <= 0) return undefined;
		return { start: Math.max(0, size - range.suffix), end: size - 1 };
	}
	const start = range.offset;
	if (start >= size) return undefined;
	if (range.length !== undefined && range.length <= 0) return undefined;
	const end = range.length === undefined ? size - 1 : Math.min(size - 1, start + range.length - 1);
	return { start, end };
}
