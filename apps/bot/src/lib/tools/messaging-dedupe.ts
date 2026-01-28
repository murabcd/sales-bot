import { regex } from "arkregex";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const EMOJI_RE = regex(
	"\\p{Emoji_Presentation}|\\p{Extended_Pictographic}",
	"gu",
);
const SPACE_RE = regex("\\s+", "g");

export function normalizeTextForComparison(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(EMOJI_RE, "")
		.replace(SPACE_RE, " ")
		.trim();
}

export function isMessagingTextDuplicate(
	text: string,
	sentTexts: string[],
): boolean {
	if (sentTexts.length === 0) return false;
	const normalized = normalizeTextForComparison(text);
	if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH)
		return false;
	return sentTexts.some((sent) => {
		const sentNormalized = normalizeTextForComparison(sent);
		if (!sentNormalized || sentNormalized.length < MIN_DUPLICATE_TEXT_LENGTH)
			return false;
		return (
			normalized.includes(sentNormalized) || sentNormalized.includes(normalized)
		);
	});
}

export function createMessagingDedupe(maxEntries = 200) {
	const sentTexts: string[] = [];

	const record = (text: string) => {
		if (!text) return;
		sentTexts.push(text);
		if (sentTexts.length > maxEntries) {
			sentTexts.splice(0, sentTexts.length - maxEntries);
		}
	};

	const shouldSend = (text: string) =>
		!isMessagingTextDuplicate(text, sentTexts);

	return { record, shouldSend };
}
