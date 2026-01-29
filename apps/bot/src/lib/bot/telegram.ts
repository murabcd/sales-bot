import type { UIMessageChunk } from "ai";
import { regex } from "arkregex";
import { markdownToTelegramHtml } from "../telegram/format.js";

type SendTextContext = {
	reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
};

type TelegramHelpersOptions = {
	textChunkLimit: number;
	logDebug: (message: string, data?: unknown) => void;
};

type RetryConfig = {
	attempts: number;
	minDelayMs: number;
	maxDelayMs: number;
	jitter: number;
};

const TELEGRAM_RETRY_DEFAULTS: RetryConfig = {
	attempts: 3,
	minDelayMs: 400,
	maxDelayMs: 30_000,
	jitter: 0.1,
};

const TELEGRAM_RETRY_RE = regex.as(
	"429|timeout|connect|reset|closed|unavailable|temporarily|network request",
	"i",
);
const TELEGRAM_PARSE_ERR_RE = regex.as(
	"can't parse entities|parse entities|find end of the entity",
	"i",
);

export function createTelegramHelpers(options: TelegramHelpersOptions) {
	const { textChunkLimit, logDebug } = options;

	function formatError(error: unknown) {
		if (typeof error === "string") return error;
		if (error && typeof error === "object" && "message" in error) {
			return String((error as { message?: unknown }).message ?? error);
		}
		return String(error);
	}

	function getRetryAfterMs(error: unknown) {
		if (!error || typeof error !== "object") return null;
		const candidate =
			"parameters" in error &&
			error.parameters &&
			typeof error.parameters === "object"
				? (error.parameters as { retry_after?: unknown }).retry_after
				: "response" in error &&
						error.response &&
						typeof error.response === "object" &&
						"parameters" in error.response
					? (
							error.response as {
								parameters?: { retry_after?: unknown };
							}
						).parameters?.retry_after
					: "error" in error &&
							error.error &&
							typeof error.error === "object" &&
							"parameters" in error.error
						? (error.error as { parameters?: { retry_after?: unknown } })
								.parameters?.retry_after
						: undefined;
		return typeof candidate === "number" && Number.isFinite(candidate)
			? candidate * 1000
			: null;
	}

	async function sleep(ms: number) {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function retryTelegram<T>(
		fn: () => Promise<T>,
		label: string,
	): Promise<T> {
		let lastError: unknown = null;
		for (
			let attempt = 1;
			attempt <= TELEGRAM_RETRY_DEFAULTS.attempts;
			attempt += 1
		) {
			try {
				return await fn();
			} catch (error) {
				lastError = error;
				const errorText = formatError(error);
				if (TELEGRAM_PARSE_ERR_RE.test(errorText)) {
					throw error;
				}
				const shouldRetry = TELEGRAM_RETRY_RE.test(errorText);
				if (!shouldRetry || attempt >= TELEGRAM_RETRY_DEFAULTS.attempts) {
					throw error;
				}
				const retryAfterMs = getRetryAfterMs(error);
				const baseDelay =
					retryAfterMs ??
					Math.min(
						TELEGRAM_RETRY_DEFAULTS.minDelayMs * 2 ** (attempt - 1),
						TELEGRAM_RETRY_DEFAULTS.maxDelayMs,
					);
				const jitter = TELEGRAM_RETRY_DEFAULTS.jitter;
				const delayMs = Math.max(
					0,
					Math.round(baseDelay * (1 + (Math.random() * 2 - 1) * jitter)),
				);
				logDebug("telegram send retry", {
					label,
					attempt,
					delayMs,
					error: errorText,
				});
				await sleep(delayMs);
			}
		}
		throw lastError ?? new Error("telegram send failed");
	}

	async function sendText(
		ctx: SendTextContext,
		text: string,
		options?: Record<string, unknown>,
	) {
		const limit =
			Number.isFinite(textChunkLimit) && textChunkLimit > 0
				? textChunkLimit
				: 4000;
		const replyOptions = options?.parse_mode
			? options
			: { ...(options ?? {}), parse_mode: "HTML" };
		const formatted = formatTelegram(text);

		try {
			if (formatted.length <= limit) {
				await retryTelegram(
					() => ctx.reply(formatted, replyOptions),
					"sendMessage",
				);
				return;
			}
			for (let i = 0; i < formatted.length; i += limit) {
				const chunk = formatted.slice(i, i + limit);
				await retryTelegram(
					() => ctx.reply(chunk, replyOptions),
					"sendMessage",
				);
			}
			return;
		} catch (error) {
			logDebug("telegram html reply failed, retrying as plain text", {
				error: String(error),
			});
		}

		const plainOptions = { ...(options ?? {}) };
		delete (plainOptions as { parse_mode?: string }).parse_mode;
		if (text.length <= limit) {
			await retryTelegram(
				() => ctx.reply(text, plainOptions),
				"sendMessage_plain",
			);
			return;
		}
		for (let i = 0; i < text.length; i += limit) {
			const chunk = text.slice(i, i + limit);
			await retryTelegram(
				() => ctx.reply(chunk, plainOptions),
				"sendMessage_plain",
			);
		}
	}

	function formatTelegram(input: string) {
		if (!input) return "";
		return markdownToTelegramHtml(input);
	}

	function appendSources(text: string, sources: Array<{ url?: string }> = []) {
		const urls = sources
			.map((source) => source.url)
			.filter((url): url is string => Boolean(url));
		if (!urls.length) return text;
		const unique = Array.from(new Set(urls));
		const lines = unique.map((url) => `- ${url}`);
		return `${text}\n\nИсточники:\n${lines.join("\n")}`;
	}

	function chunkText(text: string, size = 64) {
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += size) {
			chunks.push(text.slice(i, i + size));
		}
		return chunks;
	}

	function createTextStream(text: string): ReadableStream<UIMessageChunk> {
		const messageId = crypto.randomUUID();
		return new ReadableStream<UIMessageChunk>({
			start(controller) {
				controller.enqueue({ type: "start", messageId });
				controller.enqueue({ type: "text-start", id: messageId });
				for (const delta of chunkText(text)) {
					controller.enqueue({ type: "text-delta", id: messageId, delta });
				}
				controller.enqueue({ type: "text-end", id: messageId });
				controller.enqueue({ type: "finish", finishReason: "stop" });
				controller.close();
			},
		});
	}

	return {
		sendText,
		formatTelegram,
		appendSources,
		createTextStream,
	};
}
