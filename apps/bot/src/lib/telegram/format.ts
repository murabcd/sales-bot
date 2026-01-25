const BOLD_PATTERN = /\*\*(.+?)\*\*/g;
const SINGLE_NEWLINE_PATTERN = /(?<!\n)\n(?!\n)/g;

export function markdownToTelegramHtml(markdown: string): string {
	const escaped = escapeHtml(markdown);
	const withParagraphs = escaped.replace(SINGLE_NEWLINE_PATTERN, "\n\n");
	return withParagraphs.replace(BOLD_PATTERN, "<b>$1</b>");
}

export function markdownToTelegramHtmlChunks(
	markdown: string,
	limit = 4000,
): string[] {
	const html = markdownToTelegramHtml(markdown);
	if (html.length <= limit) return [html];
	const chunks: string[] = [];
	const lines = html.split("\n");
	let buffer = "";
	for (const line of lines) {
		const candidate = buffer ? `${buffer}\n${line}` : line;
		if (candidate.length > limit) {
			if (buffer) {
				chunks.push(buffer);
				buffer = line;
			} else {
				chunks.push(line.slice(0, limit));
				const rest = line.slice(limit);
				if (rest) buffer = rest;
			}
		} else {
			buffer = candidate;
		}
	}
	if (buffer) chunks.push(buffer);
	return chunks;
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
