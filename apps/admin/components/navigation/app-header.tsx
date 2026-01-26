"use client";

import { usePathname } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";

const pageNames: Record<string, string> = {
	"/": "Overview",
	"/channels": "Channels",
	"/sessions": "Sessions",
	"/cron": "Cron",
	"/skills": "Skills",
	"/settings": "Settings",
};

export function AppHeader() {
	const pathname = usePathname();
	const title = pageNames[pathname] ?? "Overview";

	return (
		<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
			<div className="flex items-center gap-3 px-4">
				<SidebarTrigger className="-ml-1" />
				<div className="h-4 w-px bg-border" />
				<span className="text-sm font-medium">{title}</span>
			</div>
		</header>
	);
}
