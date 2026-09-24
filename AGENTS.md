# AGENTS.md

A [Flue](https://flueframework.com) app on the Cloudflare target: a GitHub webhook dispatches PR review requests to the `VideoReviewer` agent, which works in a Cloudflare Sandbox container and publishes a recording to R2 and the PR. See README.md for the architecture.

## Layout

- `src/agents/video-reviewer.ts`: the agent. Its function name is its durable identity (Durable Object class `FlueVideoReviewerAgent`); renaming it needs a `renamed_classes` migration.
- `src/channels/github.ts`: webhook ingress and dispatch. `src/github.ts`: Octokit client and PR comment.
- `src/app.ts`: the route map. `src/cloudflare.ts`: Worker exports (the `Sandbox` Durable Object).
- `recorder/`: code baked into the container image; changes need a redeploy to rebuild the image.
- `wrangler.jsonc`: append migrations, never rewrite deployed ones. Run `pnpm typegen` after binding changes.

## Commands

- `pnpm check:types`: typecheck.
- `pnpm build`: build the Worker.
- `pnpm run deploy`: build, then deploy with `.env` as secrets (needs Docker for the image).
- `pnpm exec flue docs search <query>`: search the Flue docs for the installed version.

Flue packages are pinned to exact versions, and `hono` is pinned to match `@flue/github` so the router types line up.
