"use client";

import { useChat } from "@ai-sdk/react";
import { generateId } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { useGateway } from "@/components/gateway-provider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GatewayChatTransport } from "@/lib/gateway-chat-transport";
import { ChatInput } from "./chat-input";
import type { AdminUIMessage } from "./chat-messages";
import { ChatMessages } from "./chat-messages";

// Store pending message in memory (cleared after use)
let pendingMessage:
	| (PromptInputMessage & { webSearchEnabled?: boolean })
	| null = null;

interface DashboardChatProps {
	chatId?: string;
	children?: React.ReactNode;
}

export function DashboardChat({
	chatId: routeChatId,
	children,
}: DashboardChatProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLDivElement>(null);
	const router = useRouter();
	const { streamChat, abortChat, config } = useGateway();
	const [hasSentPending, setHasSentPending] = useState(false);
	const [inputHeight, setInputHeight] = useState(0);

	// Generate a chat ID if not provided
	const chatId = useMemo(() => routeChatId ?? generateId(), [routeChatId]);

	const transport = useMemo(
		() => new GatewayChatTransport(streamChat, abortChat),
		[streamChat, abortChat],
	);

	const { messages, sendMessage, status, stop } = useChat<AdminUIMessage>({
		id: chatId,
		transport,
	});

	const isLoading = status === "streaming" || status === "submitted";
	const hasMessages = messages.length > 0;
	const messagesLength = messages.length;

	const getScrollViewport = useCallback(() => {
		return scrollRef.current?.querySelector<HTMLElement>(
			"[data-radix-scroll-area-viewport]",
		);
	}, []);

	useEffect(() => {
		if (!inputRef.current) return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			setInputHeight(entry.contentRect.height);
		});
		observer.observe(inputRef.current);
		return () => observer.disconnect();
	}, []);

	// Send pending message after navigation to chat page
	useEffect(() => {
		if (routeChatId && pendingMessage && !hasSentPending) {
			const message = pendingMessage;
			pendingMessage = null;
			setHasSentPending(true);

			sendMessage({
				text: message.text ?? "",
				files: message.files ?? [],
				metadata: {
					webSearchEnabled: message.webSearchEnabled,
				},
			});
		}
	}, [routeChatId, hasSentPending, sendMessage]);

	// Auto-scroll to bottom when new messages arrive
	// biome-ignore lint/correctness/useExhaustiveDependencies: messagesLength is intentionally used to trigger scroll on new messages
	useEffect(() => {
		const viewport = getScrollViewport();
		if (viewport && hasMessages) {
			viewport.scrollTop = viewport.scrollHeight;
		}
	}, [messagesLength, hasMessages, getScrollViewport]);

	const handleSubmit = useCallback(
		async (message: PromptInputMessage & { webSearchEnabled?: boolean }) => {
			if (isLoading) return;

			// If on overview page (no routeChatId), store message and navigate
			if (!routeChatId) {
				pendingMessage = message;
				router.push(`/chat/${chatId}`);
				return;
			}

			// Otherwise send directly
			sendMessage({
				text: message.text ?? "",
				files: message.files ?? [],
				metadata: {
					webSearchEnabled: message.webSearchEnabled,
				},
			});
		},
		[isLoading, routeChatId, router, chatId, sendMessage],
	);

	const defaultWebSearchEnabled = config.WEB_SEARCH_ENABLED === "1";
	const contentPaddingBottom =
		inputHeight > 0
			? `calc(${inputHeight}px + 1rem + env(safe-area-inset-bottom))`
			: "7rem";

	return (
		<div className="relative flex flex-col h-[calc(100dvh-56px)] md:h-[calc(100vh-56px-48px)] -mx-4 -mb-4 md:-mx-6 md:-mb-6">
			{/* Main content area */}
			<div className="flex-1 overflow-hidden">
				{hasMessages ? (
					// Chat view - show messages
					<ScrollArea className="h-full" ref={scrollRef}>
						<div
							className="max-w-2xl mx-auto w-full px-4 py-6"
							style={{ paddingBottom: contentPaddingBottom }}
						>
							<ChatMessages messages={messages} isLoading={isLoading} />
						</div>
					</ScrollArea>
				) : (
					// Home view - show widgets
					<ScrollArea className="h-full">
						<div
							className="px-4 pt-0 md:px-6"
							style={{ paddingBottom: contentPaddingBottom }}
						>
							{children}
						</div>
					</ScrollArea>
				)}
			</div>

			{/* Sticky chat input at bottom - positioned within this container */}
			<div
				className="absolute bottom-0 left-0 right-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:pb-0"
				ref={inputRef}
			>
				<div className="max-w-2xl mx-auto w-full px-4 pt-4 pb-0">
					<ChatInput
						defaultWebSearchEnabled={defaultWebSearchEnabled}
						status={status}
						onStop={stop}
						onSubmitMessage={handleSubmit}
					/>
				</div>
			</div>
		</div>
	);
}
