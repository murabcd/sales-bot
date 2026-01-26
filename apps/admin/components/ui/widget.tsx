"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";

interface WidgetProps {
	title: string;
	description?: React.ReactNode;
	icon?: React.ReactNode;
	value?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
	onClick?: () => void;
}

export function Widget({
	title,
	description,
	icon,
	value,
	actions,
	children,
	className,
	onClick,
}: WidgetProps) {
	const content = (
		<>
			<div>
				<div className="flex items-center justify-between mb-3">
					<div className="flex items-center gap-2">
						{icon && <span className="text-muted-foreground">{icon}</span>}
						<h3 className="text-xs text-muted-foreground font-medium">
							{title}
						</h3>
					</div>
				</div>

				{typeof description === "string" ? (
					<p className="text-sm text-muted-foreground">{description}</p>
				) : (
					description
				)}
			</div>

			<div>
				{value && <h2 className="text-2xl font-normal mb-2">{value}</h2>}
				{children}
				{actions && (
					<span className="text-xs text-muted-foreground group-hover:text-primary transition-colors duration-300">
						{actions}
					</span>
				)}
			</div>
		</>
	);

	const baseClasses = cn(
		"rounded-lg border p-4 h-[210px] flex flex-col justify-between",
		"bg-background dark:bg-[#0c0c0c]",
		"dark:border-[#1d1d1d]",
		"transition-all duration-300",
		"hover:bg-accent/50 dark:hover:bg-[#0f0f0f]",
		"dark:hover:border-[#222222]",
		"group",
		className,
	);

	if (onClick) {
		return (
			<button
				type="button"
				className={cn(baseClasses, "text-left w-full cursor-pointer")}
				onClick={onClick}
			>
				{content}
			</button>
		);
	}

	return <div className={baseClasses}>{content}</div>;
}

interface WidgetGridProps {
	children: React.ReactNode;
	className?: string;
}

export function WidgetGrid({ children, className }: WidgetGridProps) {
	return (
		<div
			className={cn(
				"grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4",
				className,
			)}
		>
			{children}
		</div>
	);
}

interface MetricCardProps {
	title: string;
	value?: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
	footer?: React.ReactNode;
}

export function MetricCard({
	title,
	value,
	children,
	className,
	footer,
}: MetricCardProps) {
	return (
		<div
			className={cn(
				"rounded-lg border p-6 flex flex-col",
				"bg-background dark:bg-[#0c0c0c]",
				"dark:border-[#1d1d1d]",
				"transition-all duration-300",
				"hover:bg-accent/50 dark:hover:bg-[#0f0f0f]",
				"dark:hover:border-[#222222]",
				"group",
				className,
			)}
		>
			<div className="mb-4">
				<h3 className="text-sm font-normal text-muted-foreground mb-1">
					{title}
				</h3>
				{value && <p className="text-3xl font-normal">{value}</p>}
			</div>
			{children}
			{footer && (
				<div className="mt-auto pt-4 border-t border-border text-xs text-muted-foreground">
					{footer}
				</div>
			)}
		</div>
	);
}
