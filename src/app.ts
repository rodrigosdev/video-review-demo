import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { channel as github } from './channels/github.ts';

const app = new Hono();

// GitHub webhook ingress: POST /channels/github/webhook. The VideoReviewer
// agent is dispatch-only, so it has no HTTP mount of its own.
app.route('/channels/github', github.route());

// Recordings from R2, linked from PR comments. Supports Range requests so
// browsers can seek (and Safari will play mp4 at all).
app.get('/videos/:key{.+}', async (c) => {
	const object = await env.VIDEOS.get(c.req.param('key'), {
		range: c.req.raw.headers,
		onlyIf: c.req.raw.headers,
	});
	if (!object) return c.notFound();

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('accept-ranges', 'bytes');
	// Keys are unique per take, so a recording never changes.
	headers.set('cache-control', 'public, max-age=31536000, immutable');

	// A failed precondition (If-None-Match) comes back without a body.
	if (!('body' in object)) return new Response(null, { status: 304, headers });

	const range = c.req.header('range') ? byteRange(object.range, object.size) : undefined;
	if (!range) return new Response(object.body, { headers });
	headers.set('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
	return new Response(object.body, { status: 206, headers });
});

/** Resolves R2's range to inclusive byte positions for Content-Range. */
function byteRange(range: R2Range | undefined, size: number) {
	if (!range) return undefined;
	// Read by value so every R2Range variant (offset/length or suffix) resolves.
	const { offset, length, suffix }: { offset?: number; length?: number; suffix?: number } = range;
	if (suffix !== undefined) return { start: size - suffix, end: size - 1 };
	const start = offset ?? 0;
	const end = length === undefined ? size - 1 : Math.min(start + length, size) - 1;
	return { start, end };
}

export default app;
