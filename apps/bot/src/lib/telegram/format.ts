import { regex } from "arkregex";
import {
	chunkMarkdownIR,
	type MarkdownIR,
	type MarkdownLinkSpan,
	markdownToIR,
} from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";

const AMP_RE = regex("&", "g");
const LT_RE = regex("<", "g");
const GT_RE = regex(">", "g");
const QUOTE_RE = regex('"', "g");

export type TelegramFormattedChunk = {
	html: string;
	text: string;
};

function escapeHtml(text: string): string {
	return text
		.replace(AMP_RE, "&amp;")
		.replace(LT_RE, "&lt;")
		.replace(GT_RE, "&gt;");
}

function escapeHtmlAttr(text: string): string {
	return escapeHtml(text).replace(QUOTE_RE, "&quot;");
}

function buildTelegramLink(link: MarkdownLinkSpan, _text: string) {
	const href = link.href.trim();
	if (!href) return null;
	if (link.start === link.end) return null;
	const safeHref = escapeHtmlAttr(href);
	return {
		start: link.start,
		end: link.end,
		open: `<a href="${safeHref}">`,
		close: "</a>",
	};
}

function renderTelegramHtml(ir: MarkdownIR): string {
	return renderMarkdownWithMarkers(ir, {
		styleMarkers: {
			bold: { open: "<b>", close: "</b>" },
			italic: { open: "<i>", close: "</i>" },
			strikethrough: { open: "<s>", close: "</s>" },
			code: { open: "<code>", close: "</code>" },
			code_block: { open: "<pre><code>", close: "</code></pre>" },
		},
		escapeText: escapeHtml,
		buildLink: buildTelegramLink,
	});
}

export function markdownToTelegramHtml(markdown: string): string {
	const ir = markdownToIR(markdown ?? "", {
		linkify: true,
		headingStyle: "none",
		blockquotePrefix: "",
	});
	return renderTelegramHtml(ir);
}

export function markdownToTelegramChunks(
	markdown: string,
	limit: number,
): TelegramFormattedChunk[] {
	const ir = markdownToIR(markdown ?? "", {
		linkify: true,
		headingStyle: "none",
		blockquotePrefix: "",
	});
	const chunks = chunkMarkdownIR(ir, limit);
	return chunks.map((chunk) => ({
		html: renderTelegramHtml(chunk),
		text: chunk.text,
	}));
}

export function markdownToTelegramHtmlChunks(
	markdown: string,
	limit: number,
): string[] {
	return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}
