# video-review-demo

A GitHub PR review agent that records a video of the change working. POC built with [Flue](https://flueframework.com) on Cloudflare, pointed at [rodrigosdev/rodrigosantos.dev](https://github.com/rodrigosdev/rodrigosantos.dev).

Open or push to a PR and the agent:

1. checks out the PR head in a Cloudflare Sandbox container
2. installs dependencies and runs the repo's checks (typecheck, lint, build)
3. starts the app, writes a Playwright demo script for the diff, and records it
4. uploads an mp4 and a GIF preview to R2
5. posts one PR comment with the inline GIF, a link to the full video, and check results

A maintainer can comment `/video <what to show>` on a PR to re-record with specific instructions.

## How it works

```
GitHub webhook ──▶ Worker: /channels/github/webhook  (signature check, trusted authors only)
                     │ dispatch()
                     ▼
                   VideoReviewer agent (Durable Object, one per PR, gpt-5.6-luna)
                     │ useAgentStart: git checkout <head sha>
                     │ bash: install, typecheck, lint, build
                     │ start_app ─┐
                     │ record_demo ┼──▶ Sandbox container: Next.js on :8080, Chromium, ffmpeg
                     │            └──▶ R2: <owner>/<repo>/pr-<n>/<sha>-<take>/demo.{mp4,gif}
                     │ post_review ──▶ GitHub comment (updated in place)
                     ▼
Browser / GitHub camo ──▶ Worker: /videos/*  (streams from R2, Range support)
```

| Path | What it is |
| --- | --- |
| `src/agents/video-reviewer.ts` | The agent: instructions, checkout hook, `start_app` / `record_demo` / `post_review` tools |
| `src/channels/github.ts` | Webhook ingress: PR events and `/video` comments, access control, dispatch |
| `src/github.ts` | Octokit client and the single sticky review comment |
| `src/app.ts` | Routes: the webhook and `/videos/*` |
| `recorder/record.mjs` | Runs in the container: records a demo script with Playwright screencast, transcodes with ffmpeg |
| `Dockerfile` | Sandbox image: `cloudflare/sandbox` + Chromium + ffmpeg + corepack + the recorder |
| `wrangler.jsonc` | Worker, container (`standard-4`), R2 bucket, migrations, required secrets |

The model never holds a credential. GitHub and R2 access happen in Worker-side tools bound to the PR, and the container only has public network access.

## Setup

Requires a Cloudflare account on Workers Paid (for Containers), **Docker running locally** (wrangler builds the container image on deploy), and an OpenAI API key.

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create video-review-demo
```

Fill in `.env`:

- `OPENAI_API_KEY`
- `GITHUB_TOKEN`: fine-grained token scoped to `rodrigosdev/rodrigosantos.dev` with **Pull requests** and **Issues** set to read and write
- `GITHUB_WEBHOOK_SECRET`: any random string, e.g. `openssl rand -hex 32`

Deploy (builds the Worker and image, uploads `.env` as secrets):

```sh
pnpm run deploy
```

Point the repo's webhook at the deployed Worker:

```sh
source .env
gh api repos/rodrigosdev/rodrigosantos.dev/hooks \
  -f name=web -F active=true \
  -f 'events[]=pull_request' -f 'events[]=issue_comment' \
  -f config[url]=https://video-review-demo.<your-subdomain>.workers.dev/channels/github/webhook \
  -f config[content_type]=json -f config[secret]="$GITHUB_WEBHOOK_SECRET"
```

## Demo

- Open a PR on the site that changes something visible. The comment appears in a few seconds, and the video replaces it in a few minutes.
- Comment `/video show it on a phone-sized screen` to re-record.
- `pnpm exec wrangler tail` streams logs live. Workers Traces in the dashboard shows each run as `invoke_agent` / `chat` / `execute_tool` spans.

The first run after a deploy pulls the container image, so do a warm-up PR before presenting.

## Limits

- Deliveries aren't deduplicated, so a manual webhook redelivery records again.
- Reviews only trigger for PR authors and commenters with write access (`OWNER`, `MEMBER`, `COLLABORATOR`).
- A crash mid-review leaves the "Recording" comment in place. Comment `/video` to retry.
- `vite dev` needs Docker too, since it builds the same container locally.
