"use client";

import type { ComponentProps, PropsWithChildren } from "react";
import {
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ModelSelectorProps = ComponentProps<typeof Popover>;

export const ModelSelector = (props: ModelSelectorProps) => (
	<Popover {...props} />
);

export const ModelSelectorTrigger = PopoverTrigger;

export const ModelSelectorContent = ({
	className,
	...props
}: ComponentProps<typeof PopoverContent>) => (
	<PopoverContent
		align="start"
		className={cn("w-[320px] p-0", className)}
		{...props}
	/>
);

export const ModelSelectorInput = ({
	className,
	...props
}: ComponentProps<typeof CommandInput>) => (
	<CommandInput className={cn(className)} {...props} />
);

export const ModelSelectorList = ({
	className,
	...props
}: ComponentProps<typeof CommandList>) => (
	<CommandList className={cn(className)} {...props} />
);

export const ModelSelectorGroup = ({
	className,
	...props
}: ComponentProps<typeof CommandGroup>) => (
	<CommandGroup className={cn(className)} {...props} />
);

export const ModelSelectorItem = ({
	className,
	...props
}: ComponentProps<typeof CommandItem>) => (
	<CommandItem className={cn("gap-2", className)} {...props} />
);

export const ModelSelectorEmpty = ({
	className,
	...props
}: ComponentProps<typeof CommandEmpty>) => (
	<CommandEmpty className={cn(className)} {...props} />
);

export const ModelSelectorName = ({
	className,
	children,
}: PropsWithChildren<{ className?: string }>) => (
	<span className={cn("text-sm", className)}>{children}</span>
);

export const ModelSelectorLogoGroup = ({
	className,
	children,
}: PropsWithChildren<{ className?: string }>) => (
	<span className={cn("ml-2 inline-flex items-center gap-1", className)}>
		{children}
	</span>
);

const providerLabelMap: Record<string, string> = {
	openai: "OAI",
	anthropic: "ANT",
	google: "G",
	azure: "AZ",
	"amazon-bedrock": "AB",
};

export const ModelSelectorLogo = ({
	provider,
	className,
}: {
	provider: string;
	className?: string;
}) => (
	<span
		className={cn(
			"inline-flex h-5 items-center rounded-full border border-border/60 px-1.5 text-[10px] uppercase text-muted-foreground",
			className,
		)}
	>
		{providerLabelMap[provider] ?? provider.slice(0, 3)}
	</span>
);
