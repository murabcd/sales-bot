import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
				outline: "text-foreground border-border",
				// Semantic status variants
				success:
					"border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
				warning:
					"border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
				error:
					"border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
				info: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
				// Muted variant for labels/tags
				muted: "border-border bg-transparent text-muted-foreground",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<div className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}

export { Badge, badgeVariants };
