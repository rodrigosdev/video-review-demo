import { Octokit } from '@octokit/rest';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';

/** Outbound GitHub API client, authenticated with the Worker's GITHUB_TOKEN secret. */
export const github = new Octokit({ auth: env.GITHUB_TOKEN });

const Slug = v.pipe(v.string(), v.regex(/^[\w.-]+$/));

/** The pull request a VideoReviewer instance is bound to (its creation data). */
export const PullRequestRef = v.object({
	owner: Slug,
	repo: Slug,
	prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type PullRequestRef = v.InferOutput<typeof PullRequestRef>;

// Identifies the one comment this app owns on each pull request.
const MARKER = '<!-- flue-video-review -->';

/** Creates the video review comment on a pull request, or updates it in place. */
export async function upsertReviewComment({ owner, repo, prNumber }: PullRequestRef, body: string) {
	const comments = await github.paginate(github.rest.issues.listComments, {
		owner,
		repo,
		issue_number: prNumber,
		per_page: 100,
	});
	const existing = comments.find((comment) => comment.body?.startsWith(MARKER));
	const markedBody = `${MARKER}\n${body}`;

	if (existing) {
		await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: markedBody });
	} else {
		await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: markedBody });
	}
}
