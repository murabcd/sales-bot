"use client";

import type { FileUIPart } from "ai";
import { XIcon } from "lucide-react";
import {
	type ButtonHTMLAttributes,
	createContext,
	type PropsWithChildren,
	useContext,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AttachmentData = FileUIPart & { id?: string };

type AttachmentContextValue = {
	data: AttachmentData;
	onRemove?: () => void;
};

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

export type AttachmentsProps = PropsWithChildren<{
	variant?: "inline" | "stacked";
	className?: string;
}>;

export const Attachments = ({
	variant = "stacked",
	className,
	children,
}: AttachmentsProps) => (
	<div
		className={cn(
			"flex flex-wrap gap-2",
			variant === "inline" ? "items-center" : "items-start",
			className,
		)}
	>
		{children}
	</div>
);

export type AttachmentProps = PropsWithChildren<{
	data: AttachmentData;
	onRemove?: () => void;
	className?: string;
}>;

export const Attachment = ({
	data,
	onRemove,
	className,
	children,
}: AttachmentProps) => (
	<AttachmentContext.Provider value={{ data, onRemove }}>
		<div
			className={cn(
				"relative flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 p-2",
				className,
			)}
		>
			{children}
		</div>
	</AttachmentContext.Provider>
);

export const AttachmentPreview = ({ className }: { className?: string }) => {
	const ctx = useContext(AttachmentContext);
	if (!ctx) return null;
	const { data } = ctx;
	const isImage = data.mediaType?.startsWith("image/");
	if (!isImage) return null;
	return (
		<img
			alt={data.filename ?? "attachment"}
			className={cn("h-12 w-12 rounded-md object-cover", className)}
			src={data.url}
		/>
	);
};

export const AttachmentRemove = ({
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>) => {
	const ctx = useContext(AttachmentContext);
	if (!ctx?.onRemove) return null;
	return (
		<Button
			{...props}
			aria-label="Remove attachment"
			className={cn("absolute -right-2 -top-2 size-6 rounded-full", className)}
			onClick={(event) => {
				event.preventDefault();
				ctx.onRemove?.();
			}}
			size="icon"
			variant="secondary"
		>
			<XIcon className="size-3" />
		</Button>
	);
};
