import { observe } from '@flue/runtime';
import { GitLabClient } from '../integrations/gitlab.ts';

/**
 * A run can die before the agent gets to say anything: the model provider
 * refuses the first request (no credits, a bad key), so there is no status
 * note to edit. This says why on the merge request, so a 👀 is never the last word.
 * GitLab only: a GitHub conversation id does not carry the installation to act as.
 */
export function watchFailures(): void {
	observe((event) => {
		if (event.type !== 'submission_settled' || event.outcome !== 'failed') return;
		const ref = parseGitLabInstanceId(event.instanceId);
		if (!ref) return;
		const body = renderFailureNote(event.error?.message ?? '');
		return new GitLabClient({ provider: 'gitlab', projectPath: '', ...ref })
			.createComment(body)
			.then(() => undefined)
			.catch((error) => console.error('[failure-note] could not post', error));
	});
}

export function parseGitLabInstanceId(id: string | undefined): { projectId: number; number: number } | null {
	const match = /^gitlab:v1:([1-9]\d*):([1-9]\d*)$/.exec(id ?? '');
	return match ? { projectId: Number(match[1]), number: Number(match[2]) } : null;
}

/** A plain reason for the people on the merge request. Raw errors stay in the Worker logs. */
export function failureReason(message: string): string {
	if (/credit balance is too low/i.test(message)) return 'The Anthropic account is out of credits.';
	if (/authentication_error|invalid x-api-key|\b401\b/i.test(message)) return 'The Anthropic API key was refused.';
	if (/rate_limit|\b429\b/i.test(message)) return 'The model provider is rate limiting requests. Try again in a few minutes.';
	if (/overloaded|\b529\b/i.test(message)) return 'The model provider is overloaded. Try again in a few minutes.';
	return 'The run stopped with an error. The operator can read it in the Worker logs.';
}

export function renderFailureNote(message: string): string {
	return [
		'**Explainer video** · ❌ Could not make the video',
		'',
		failureReason(message),
		'',
		'<sub>Comment `/explain-vid` to try again once it is fixed.</sub>',
	].join('\n');
}
