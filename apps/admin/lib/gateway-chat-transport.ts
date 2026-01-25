"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

type StreamChat = (params: {
	text: string;
	chatId?: string;
	userId?: string;
	userName?: string;
	chatType?: "private" | "group" | "supergroup" | "channel";
}) => Promise<{ stream: ReadableStream<unknown>; streamId: string }>;

type AbortChat = (streamId: string) => Promise<{ ok: boolean }>;

function extractLastUserText<UI_MESSAGE extends UIMessage>(
	messages: UI_MESSAGE[],
) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = message.parts
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
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
		const text = extractLastUserText(messages);
		if (!text) {
			throw new Error("empty_message");
		}
		const { stream, streamId } = await this.streamChat({
			text,
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
