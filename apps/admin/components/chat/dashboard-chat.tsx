"use client";

import { generateId } from "ai";
import { useChat } from "@ai-sdk/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGateway } from "@/components/gateway-provider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GatewayChatTransport } from "@/lib/gateway-chat-transport";
import { ChatInput } from "./chat-input";
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
	const [input, setInput] = useState("");
	const { streamChat, abortChat } = useGateway();

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

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const text = input.trim();
		if (!text || isLoading) return;
		setInput("");
		sendMessage({ text });
	};

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
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onSubmit={handleSubmit}
						onStop={stop}
						isLoading={isLoading}
						placeholder="Ask anything about the system..."
					/>
				</div>
			</div>
		</div>
	);
}
