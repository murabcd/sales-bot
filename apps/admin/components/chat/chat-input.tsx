"use client";

import type { ChatStatus } from "ai";
import { CheckIcon, GlobeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Attachment,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorName,
	ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
	PromptInput,
	PromptInputActionAddAttachments,
	PromptInputActionMenu,
	PromptInputActionMenuContent,
	PromptInputActionMenuTrigger,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	type PromptInputMessage,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
	usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Command } from "@/components/ui/command";

const models = [
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		chef: "OpenAI",
		chefSlug: "openai",
		providers: ["openai"],
	},
	{
		id: "gpt-4.1",
		name: "GPT-4.1",
		chef: "OpenAI",
		chefSlug: "openai",
		providers: ["openai"],
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		chef: "OpenAI",
		chefSlug: "openai",
		providers: ["openai"],
	},
];

const PromptInputAttachmentsDisplay = () => {
	const attachments = usePromptInputAttachments();

	if (attachments.files.length === 0) {
		return null;
	}

	return (
		<Attachments variant="inline">
			{attachments.files.map((attachment) => (
				<Attachment
					data={attachment}
					key={attachment.id}
					onRemove={() => attachments.remove(attachment.id)}
				>
					<AttachmentPreview />
					<AttachmentRemove />
				</Attachment>
			))}
		</Attachments>
	);
};

const HeaderControls = () => {
	const controller = usePromptInputController();

	return (
		<header className="mt-8 hidden items-center justify-between">
			<p className="text-sm">
				Header Controls via{" "}
				<code className="rounded-md bg-muted p-1 font-bold">
					PromptInputProvider
				</code>
			</p>
			<ButtonGroup>
				<Button
					onClick={() => {
						controller.textInput.clear();
					}}
					size="sm"
					type="button"
					variant="outline"
				>
					Clear input
				</Button>
				<Button
					onClick={() => {
						controller.textInput.setInput("Inserted via PromptInputProvider");
					}}
					size="sm"
					type="button"
					variant="outline"
				>
					Set input
				</Button>

				<Button
					onClick={() => {
						controller.attachments.clear();
					}}
					size="sm"
					type="button"
					variant="outline"
				>
					Clear attachments
				</Button>
			</ButtonGroup>
		</header>
	);
};

interface ChatInputProps {
	status?: ChatStatus;
	onStop?: () => void;
	onSubmitMessage: (
		message: PromptInputMessage & { webSearchEnabled?: boolean },
	) => void | Promise<void>;
	defaultWebSearchEnabled?: boolean;
}

export function ChatInput({
	status,
	onStop,
	onSubmitMessage,
	defaultWebSearchEnabled = false,
}: ChatInputProps) {
	const [model, setModel] = useState<string>(models[0].id);
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [webSearchEnabled, setWebSearchEnabled] = useState(
		defaultWebSearchEnabled,
	);

	useEffect(() => {
		setWebSearchEnabled(defaultWebSearchEnabled);
	}, [defaultWebSearchEnabled]);

	const selectedModelData = useMemo(
		() => models.find((candidate) => candidate.id === model),
		[model],
	);

	return (
		<div className="size-full">
			<PromptInputProvider>
				<PromptInput
					accept="image/*"
					globalDrop
					multiple
					onSubmit={(message) => {
						return onSubmitMessage({
							...message,
							webSearchEnabled,
						});
					}}
				>
					<PromptInputAttachmentsDisplay />
					<PromptInputBody>
						<PromptInputTextarea placeholder="Ask anything about the system..." />
					</PromptInputBody>
					<PromptInputFooter>
						<PromptInputTools>
							<PromptInputActionMenu>
								<PromptInputActionMenuTrigger />
								<PromptInputActionMenuContent>
									<PromptInputActionAddAttachments />
								</PromptInputActionMenuContent>
							</PromptInputActionMenu>
							<PromptInputButton
								aria-pressed={webSearchEnabled}
								className={webSearchEnabled ? "bg-muted" : undefined}
								onClick={() => setWebSearchEnabled((prev) => !prev)}
								type="button"
								variant={webSearchEnabled ? "secondary" : "ghost"}
							>
								<GlobeIcon size={16} />
								<span>Search</span>
							</PromptInputButton>
							<ModelSelector
								onOpenChange={setModelSelectorOpen}
								open={modelSelectorOpen}
							>
								<ModelSelectorTrigger asChild>
									<PromptInputButton
										className="ml-1"
										size="sm"
										type="button"
										variant="ghost"
									>
										{selectedModelData?.name && (
											<ModelSelectorName>
												{selectedModelData.name}
											</ModelSelectorName>
										)}
									</PromptInputButton>
								</ModelSelectorTrigger>
								<ModelSelectorContent>
									<Command>
										<ModelSelectorInput placeholder="Search models..." />
										<ModelSelectorList>
											<ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
											{["OpenAI"].map((chef) => {
												const group = models.filter(
													(candidate) => candidate.chef === chef,
												);
												if (group.length === 0) return null;
												return (
													<ModelSelectorGroup heading={chef} key={chef}>
														{group.map((candidate) => (
															<ModelSelectorItem
																key={candidate.id}
																onSelect={() => {
																	setModel(candidate.id);
																	setModelSelectorOpen(false);
																}}
																value={candidate.id}
															>
																<ModelSelectorName>
																	{candidate.name}
																</ModelSelectorName>
																{model === candidate.id ? (
																	<CheckIcon className="ml-auto size-4" />
																) : (
																	<div className="ml-auto size-4" />
																)}
															</ModelSelectorItem>
														))}
													</ModelSelectorGroup>
												);
											})}
										</ModelSelectorList>
									</Command>
								</ModelSelectorContent>
							</ModelSelector>
						</PromptInputTools>
						<PromptInputSubmit onStop={onStop} status={status} />
					</PromptInputFooter>
				</PromptInput>

				<HeaderControls />
			</PromptInputProvider>
		</div>
	);
}
