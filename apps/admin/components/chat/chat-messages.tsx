"use client";

import type {
	DataUIPart,
	DynamicToolUIPart,
	FileUIPart,
	SourceDocumentUIPart,
	ToolUIPart,
	UIMessage,
} from "ai";
import { CopyIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useState } from "react";
import {
	Attachment,
	AttachmentPreview,
	Attachments,
} from "@/components/ai-elements/attachments";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/messages";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	Source,
	Sources,
	SourcesContent,
	SourcesTrigger,
} from "@/components/ai-elements/sources";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { Icons } from "@/components/icons";

export type ToolStatusData = {
	tools: string[];
};

export type AdminUIData = {
	tools?: ToolStatusData;
	webSearchEnabled?: boolean;
};

export type AdminUIMessage = UIMessage<AdminUIData>;

interface ChatMessagesProps {
	messages: AdminUIMessage[];
	isLoading?: boolean;
}

// Hoisted static JSX - avoids recreation on every render
const EmptyState = (
	<div className="flex flex-1 items-center justify-center p-8">
		<div className="text-center space-y-2">
			<Icons.sparkles className="size-8" />
			<p className="text-sm text-muted-foreground">
				Start a conversation with your assistant
			</p>
			<p className="text-xs text-muted-foreground/60">
				Ask about system status, run operations, or get help
			</p>
		</div>
	</div>
);

export function ChatMessages({ messages, isLoading }: ChatMessagesProps) {
	const [liked, setLiked] = useState<Record<string, boolean>>({});
	const [disliked, setDisliked] = useState<Record<string, boolean>>({});

	const handleCopy = (content: string) => {
		navigator.clipboard.writeText(content);
	};

	const hasAssistantText = messages.some(
		(message) =>
			message.role === "assistant" &&
			message.parts.some(
				(part) => part.type === "text" && part.text.trim().length > 0,
			),
	);

	if (messages.length === 0) {
		return EmptyState;
	}

	return (
		<div className="flex flex-col gap-4">
			{messages.map((message) => {
				const text = message.parts
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				const toolParts = message.parts.filter(
					(part): part is DataUIPart<AdminUIData> & { type: "data-tools" } =>
						part.type === "data-tools",
				);
				const toolCallParts = message.parts.filter(
					(part): part is ToolUIPart | DynamicToolUIPart =>
						part.type === "dynamic-tool" || part.type.startsWith("tool-"),
				);
				const sourceParts = message.parts.filter(
					(part): part is SourceDocumentUIPart =>
						part.type === "source-document",
				);
				const sources = sourceParts
					.map((part, index) => {
						const source = part as SourceDocumentUIPart & {
							url?: unknown;
							title?: unknown;
							id?: unknown;
						};
						const href = typeof source.url === "string" ? source.url : "";
						if (!href) return null;
						const title =
							typeof source.title === "string" && source.title.trim()
								? source.title
								: href;
						const key =
							typeof source.id === "string" ? source.id : `${href}-${index}`;
						return { href, title, key };
					})
					.filter(
						(source): source is { href: string; title: string; key: string } =>
							Boolean(source),
					);
				const fileParts = message.parts.filter(
					(part): part is FileUIPart =>
						part.type === "file" &&
						typeof part.mediaType === "string" &&
						(part.mediaType.startsWith("image/") ||
							part.mediaType === "application/pdf"),
				);

				return (
					<Message from={message.role} key={message.id}>
						{fileParts.length > 0 ? (
							<Attachments className="mb-2" variant="stacked">
								{fileParts.map((part, index) => (
									<Attachment data={part} key={`${message.id}-file-${index}`}>
										<AttachmentPreview />
									</Attachment>
								))}
							</Attachments>
						) : null}
						{message.role === "assistant" ? (
							<div className="flex gap-3">
								<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground mt-0.5">
									<Icons.sparkles className="size-3" />
								</div>
							<div className="flex-1 min-w-0">
								{toolCallParts.length > 0 ? (
									<div className="space-y-2 mt-2">
										{toolCallParts.map((part, index) => {
											const toolKey =
												typeof part.toolCallId === "string"
													? part.toolCallId
													: `${message.id}-${index}`;
											const toolTitle =
												part.type === "dynamic-tool"
													? part.toolName
													: part.type.split("-").slice(1).join("-");
											return (
												<Tool defaultOpen={false} key={toolKey}>
													{part.type === "dynamic-tool" ? (
														<ToolHeader
															state={part.state}
															title={toolTitle}
															type="dynamic-tool"
															toolName={part.toolName}
														/>
													) : (
														<ToolHeader
															state={part.state}
															title={toolTitle}
															type={part.type}
														/>
													)}
													<ToolContent>
														<ToolInput input={part.input ?? {}} />
														<ToolOutput
															errorText={part.errorText}
															output={part.output as React.ReactNode}
														/>
													</ToolContent>
												</Tool>
											);
										})}
									</div>
								) : null}
								<MessageContent>
									<MessageResponse>{text}</MessageResponse>
									{toolParts.map((part, i) => {
										const tools = Array.isArray(part.data?.tools)
											? part.data.tools.join(", ")
											: "";
										if (!tools) return null;
										return (
											<div
												key={`${message.id}-tools-${i}`}
												className="mt-2 rounded-md bg-background/60 px-2 py-1 text-xs text-muted-foreground"
											>
												Tools: {tools}
											</div>
										);
									})}
								</MessageContent>
									{sources.length > 0 ? (
										<Sources>
											<SourcesTrigger count={sources.length} />
											<SourcesContent>
												{sources.map((source) => (
													<Source
														href={source.href}
														key={source.key ?? source.href}
														title={source.title}
													/>
												))}
											</SourcesContent>
										</Sources>
									) : null}
									{text.trim().length > 0 ? (
										<MessageActions className="mt-3">
											<MessageAction
												label="Like"
												onClick={() =>
													setLiked((prev) => ({
														...prev,
														[message.id]: !prev[message.id],
													}))
												}
												tooltip="Like this response"
											>
												<ThumbsUpIcon
													className="size-4"
													fill={liked[message.id] ? "currentColor" : "none"}
												/>
											</MessageAction>
											<MessageAction
												label="Dislike"
												onClick={() =>
													setDisliked((prev) => ({
														...prev,
														[message.id]: !prev[message.id],
													}))
												}
												tooltip="Dislike this response"
											>
												<ThumbsDownIcon
													className="size-4"
													fill={disliked[message.id] ? "currentColor" : "none"}
												/>
											</MessageAction>
											<MessageAction
												label="Copy"
												onClick={() => handleCopy(text)}
												tooltip="Copy to clipboard"
											>
												<CopyIcon className="size-4" />
											</MessageAction>
										</MessageActions>
									) : null}
								</div>
							</div>
						) : (
							<MessageContent>
								<div className="whitespace-pre-wrap">{text}</div>
							</MessageContent>
						)}
					</Message>
				);
			})}
			{isLoading && !hasAssistantText && (
				<Message from="assistant">
					<div className="flex gap-3">
						<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground mt-0.5">
							<Icons.sparkles className="size-3" />
						</div>
						<MessageContent>
							<Shimmer>Thinking...</Shimmer>
						</MessageContent>
					</div>
				</Message>
			)}
		</div>
	);
}
