"use client";

import { ArrowUp, Square } from "lucide-react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ChatInputProps {
	value: string;
	onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
	onSubmit: (e: FormEvent<HTMLFormElement>) => void;
	onStop?: () => void;
	isLoading?: boolean;
	placeholder?: string;
}

export function ChatInput({
	value,
	onChange,
	onSubmit,
	onStop,
	isLoading,
	placeholder = "Ask anything...",
}: ChatInputProps) {
	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (value.trim() && !isLoading) {
				const form = e.currentTarget.form;
				if (form) {
					form.requestSubmit();
				}
			}
		}
	};

	return (
		<form onSubmit={onSubmit} className="relative">
			<Textarea
				value={value}
				onChange={onChange}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				rows={1}
				className={cn(
					"min-h-[52px] max-h-[200px] resize-none pr-12 rounded-xl",
					"bg-background border-border focus-visible:ring-ring",
				)}
				disabled={isLoading}
			/>
			<div className="absolute right-2 bottom-2">
				{isLoading ? (
					<Button
						type="button"
						size="icon"
						variant="ghost"
						onClick={onStop}
						className="size-8 rounded-lg"
					>
						<Square className="size-4 fill-current" />
					</Button>
				) : (
					<Button
						type="submit"
						size="icon"
						disabled={!value.trim()}
						className="size-8 rounded-lg"
					>
						<ArrowUp className="size-4" />
					</Button>
				)}
			</div>
		</form>
	);
}
