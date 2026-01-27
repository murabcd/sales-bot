"use client";

import type { ChatTransport, FileUIPart, UIMessage, UIMessageChunk } from "ai";

type StreamChat = (params: {
	text: string;
	files?: Array<{ mediaType: string; url: string; filename?: string }>;
	webSearchEnabled?: boolean;
	chatId?: string;
	userId?: string;
	userName?: string;
	chatType?: "private" | "group" | "supergroup" | "channel";
}) => Promise<{ stream: ReadableStream<unknown>; streamId: string }>;

type AbortChat = (streamId: string) => Promise<{ ok: boolean }>;

function extractLastUserPayload<UI_MESSAGE extends UIMessage>(
	messages: UI_MESSAGE[],
) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = message.parts
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.trim();
		const files = message.parts.filter(
			(part): part is FileUIPart =>
				part.type === "file" &&
				typeof part.mediaType === "string" &&
				part.mediaType.startsWith("image/"),
		);
		const metadata =
			message.metadata && typeof message.metadata === "object"
				? (message.metadata as { webSearchEnabled?: boolean })
				: undefined;
		const webSearchEnabled =
			typeof metadata?.webSearchEnabled === "boolean"
				? metadata.webSearchEnabled
				: undefined;
		if (text || files.length > 0) return { text, files, webSearchEnabled };
	}
	return { text: "", files: [], webSearchEnabled: undefined };
}

export class GatewayChatTransport<UI_MESSAGE extends UIMessage>
	implements ChatTransport<UI_MESSAGE>
{
	constructor(
		private streamChat: StreamChat,
		private abortChat: AbortChat,
	) {}

	async sendMessages({
		chatId,
		messages,
		abortSignal,
	}: Parameters<ChatTransport<UI_MESSAGE>["sendMessages"]>[0]): Promise<
		ReadableStream<UIMessageChunk>
	> {
		const { text, files, webSearchEnabled } = extractLastUserPayload(messages);
		if (!text && files.length === 0) {
			throw new Error("empty_message");
		}
		const { stream, streamId } = await this.streamChat({
			text,
			files,
			webSearchEnabled,
			chatId,
		});
		if (abortSignal) {
			abortSignal.addEventListener(
				"abort",
				() => {
					try {
						stream.cancel();
					} catch {
						// Ignore stream cancellation errors.
					}
					void this.abortChat(streamId);
				},
				{ once: true },
			);
		}
		return stream as ReadableStream<UIMessageChunk>;
	}

	async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
		return null;
	}
}
