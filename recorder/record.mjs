// Records one agent-written demo script in headless Chromium.
//
//   node /opt/recorder/record.mjs <demo.mjs> <out-dir> <base-url>
//
// The demo module default-exports `async ({ page }) => {}` and may export a
// `viewport` ({ width, height }). Page-relative URLs resolve against base-url.
// Writes demo.mp4 and demo.gif to out-dir and prints one JSON result line to
// stdout; everything else goes to stderr.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';

const SCRIPT_TIMEOUT_MS = 120_000;
// GitHub proxies comment images through camo; keep the preview GIF small.
const GIF_BUDGET_BYTES = 5_000_000;

const [scriptPath, outDir, baseURL] = process.argv.slice(2);
if (!scriptPath || !outDir || !baseURL) {
	console.error('usage: record.mjs <demo.mjs> <out-dir> <base-url>');
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const files = {
	webm: path.join(outDir, 'demo.webm'),
	mp4: path.join(outDir, 'demo.mp4'),
	gif: path.join(outDir, 'demo.gif'),
};

const result = await record();
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);

async function record() {
	let demo;
	try {
		demo = await import(pathToFileURL(path.resolve(scriptPath)).href);
	} catch (error) {
		return { ok: false, error: `Could not load demo script: ${message(error)}` };
	}
	if (typeof demo.default !== 'function') {
		return { ok: false, error: 'Demo script must default-export an async function ({ page }) => {}.' };
	}

	const viewport = demo.viewport ?? { width: 1280, height: 720 };
	const pageErrors = [];
	const consoleErrors = [];
	const failedRequests = [];

	const browser = await chromium.launch();
	let failure;
	let durationSec = 0;
	try {
		const context = await browser.newContext({ baseURL, viewport });
		const page = await context.newPage();
		page.setDefaultTimeout(10_000);
		page.setDefaultNavigationTimeout(30_000);
		page.on('pageerror', (error) => pageErrors.push(error.message));
		page.on('console', (msg) => {
			// Failed loads are reported with their URL via failedRequests instead.
			if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) consoleErrors.push(msg.text());
		});
		page.on('response', (response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.screencast.start({ path: files.webm, size: viewport });
		const startedAt = Date.now();
		await page.screencast.showActions({ cursor: 'pointer', position: 'bottom-right', fontSize: 16, duration: 800 });
		try {
			await withTimeout(demo.default({ page }), SCRIPT_TIMEOUT_MS);
			// Hold the final state so viewers can see where the flow ended.
			await page.waitForTimeout(1500);
		} catch (error) {
			failure = message(error);
		}
		await page.screencast.stop();
		durationSec = Math.round((Date.now() - startedAt) / 100) / 10;
		await context.close();
	} finally {
		await browser.close();
	}

	const diagnostics = { pageErrors, consoleErrors, failedRequests };
	if (failure) return { ok: false, error: failure, ...diagnostics };

	transcode();
	return {
		ok: true,
		durationSec,
		mp4Bytes: statSync(files.mp4).size,
		gifBytes: statSync(files.gif).size,
		...diagnostics,
	};
}

function transcode() {
	ffmpeg([
		'-i', files.webm,
		'-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
		'-movflags', '+faststart', '-an', files.mp4,
	]);
	// Try a sharper GIF first, then fall back to a smaller one if it's too big.
	for (const { fps, size } of [{ fps: 10, size: 720 }, { fps: 8, size: 560 }, { fps: 6, size: 420 }]) {
		ffmpeg([
			'-i', files.mp4,
			'-vf',
			`fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,` +
				'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
			files.gif,
		]);
		if (statSync(files.gif).size <= GIF_BUDGET_BYTES) return;
	}
}

function ffmpeg(args) {
	execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Demo script timed out after ${ms / 1000}s`)), ms)),
	]);
}

function message(error) {
	// Playwright colors its call logs; the agent reads plain text.
	return (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '');
}
