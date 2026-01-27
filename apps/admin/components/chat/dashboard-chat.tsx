"use client";

import { generateId } from "ai";
import { useChat } from "@ai-sdk/react";
import { useEffect, useMemo, useRef } from "react";
import { useGateway } from "@/components/gateway-provider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GatewayChatTransport } from "@/lib/gateway-chat-transport";
import { ChatInput } from "./chat-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { AdminUIMessage } from "./chat-messages";
import { ChatMessages } from "./chat-messages";

interface DashboardChatProps {
	chatId?: string;
	children?: React.ReactNode;
}

export function DashboardChat({
	chatId: routeChatId,
	children,
}: DashboardChatProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const { streamChat, abortChat, config } = useGateway();

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

	// Auto-scroll to bottom when new messages arrive
	// biome-ignore lint/correctness/useExhaustiveDependencies: messagesLength is intentionally used to trigger scroll on new messages
	useEffect(() => {
		if (scrollRef.current && hasMessages) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messagesLength, hasMessages]);

	const handleSubmit = async (
		message: PromptInputMessage & { webSearchEnabled?: boolean },
	) => {
		if (isLoading) return;
		sendMessage({
			text: message.text ?? "",
			files: message.files ?? [],
			metadata: {
				webSearchEnabled: message.webSearchEnabled,
			},
		});
	};

	const defaultWebSearchEnabled = config.WEB_SEARCH_ENABLED === "1";

	return (
		<div className="relative flex flex-col h-[calc(100vh-56px-48px)] -m-6">
			{/* Main content area */}
			<div className="flex-1 overflow-hidden">
				{hasMessages ? (
					// Chat view - show messages
					<ScrollArea className="h-full" ref={scrollRef}>
						<div className="max-w-2xl mx-auto w-full px-4 py-6 pb-28">
							<ChatMessages messages={messages} isLoading={isLoading} />
						</div>
					</ScrollArea>
				) : (
					// Home view - show widgets
					<ScrollArea className="h-full">
						<div className="p-6 pb-28">{children}</div>
					</ScrollArea>
				)}
			</div>

			{/* Sticky chat input at bottom - positioned within this container */}
			<div className="absolute bottom-0 left-0 right-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="max-w-2xl mx-auto w-full p-4">
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
