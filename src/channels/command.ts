/** The slash command, as the first token of a pull-request or merge-request comment. */
export const EXPLAIN_COMMAND = '/explain-vid';

/** `/explain-vid` alone, or followed by whitespace and a note. `/explain-video` is not it. */
export function isExplainCommand(body: string): boolean {
	return body === EXPLAIN_COMMAND || /^\/explain-vid\s/.test(body);
}

/** The note after the command (it steers the video), or `null` when the comment is not the command. */
export function parseExplainCommand(comment: string): { request: string } | null {
	const body = comment.trim();
	if (!isExplainCommand(body)) return null;
	return { request: body.slice(EXPLAIN_COMMAND.length).trim() };
}
