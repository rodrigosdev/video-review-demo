import { createGitHubChannel } from '@flue/github';
import { dispatch } from '@flue/runtime';
import { env } from 'cloudflare:workers';
import { REVIEW_SIGNAL, type ReviewRequest, VideoReviewer } from '../agents/video-reviewer.ts';
import { github, type PullRequestRef, upsertReviewComment } from '../github.ts';

// Reviews spend container time and model tokens, so only people with write
// access to the repo can trigger them.
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const VIDEO_COMMAND = /^\/video\b/;

// The fields shared by webhook pull_request payloads and `pulls.get` responses.
interface PullRequestFacts {
	number: number;
	title: string;
	body: string | null;
	user: { login: string } | null;
	head: { sha: string; ref: string };
	base: { sha: string; ref: string };
}

export const channel = createGitHubChannel({
	webhookSecret: env.GITHUB_WEBHOOK_SECRET,

	// Path: /channels/github/webhook. Subscribe the webhook to "Pull requests"
	// and "Issue comments".
	async webhook({ c, delivery }) {
		const origin = new URL(c.req.url).origin;

		// Opening a PR or pushing to it records a new video.
		if (delivery.name === 'pull_request') {
			const { action, pull_request, repository } = delivery.payload;
			if (!REVIEW_ACTIONS.has(action) || pull_request.draft) return;
			if (!TRUSTED_ASSOCIATIONS.has(pull_request.author_association)) return;
			await requestReview({ owner: repository.owner.login, repo: repository.name }, pull_request, origin);
			return;
		}

		// "/video <what to show>" on a PR re-records, steered by the rest of the comment.
		if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
			const { issue, comment, repository } = delivery.payload;
			const command = comment.body.trim();
			if (!issue.pull_request || !VIDEO_COMMAND.test(command)) return;
			if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) return;

			const repoRef = { owner: repository.owner.login, repo: repository.name };
			const [{ data: pullRequest }] = await Promise.all([
				github.rest.pulls.get({ ...repoRef, pull_number: issue.number }),
				github.rest.reactions.createForIssueComment({ ...repoRef, comment_id: comment.id, content: 'eyes' }),
			]);
			await requestReview(repoRef, pullRequest, origin, command.replace(VIDEO_COMMAND, '').trim());
		}
	},
});

async function requestReview(
	repoRef: Omit<PullRequestRef, 'prNumber'>,
	pullRequest: PullRequestFacts,
	origin: string,
	instructions?: string,
) {
	const pr: PullRequestRef = { ...repoRef, prNumber: pullRequest.number };
	const attributes = {
		headSha: pullRequest.head.sha,
		baseSha: pullRequest.base.sha,
		origin,
	} satisfies ReviewRequest;

	await dispatch(VideoReviewer, {
		id: channel.instanceId({ owner: pr.owner, repo: pr.repo, issueNumber: pr.prNumber }),
		initialData: pr,
		message: { kind: 'signal', type: REVIEW_SIGNAL, body: signalBody(pullRequest, instructions), attributes },
	});
	await upsertReviewComment(
		pr,
		`### 🎬 Video review\n\nRecording \`${attributes.headSha.slice(0, 7)}\`. This comment updates when the video is ready.`,
	);
}

function signalBody(pullRequest: PullRequestFacts, instructions: string | undefined) {
	return [
		`Pull request #${pullRequest.number}: ${pullRequest.title}`,
		`Author: @${pullRequest.user?.login ?? 'unknown'}. ${pullRequest.head.ref} into ${pullRequest.base.ref}.`,
		'',
		pullRequest.body?.trim() || '(no description)',
		...(instructions ? ['', `Reviewer instructions: ${instructions}`] : []),
	].join('\n');
}
