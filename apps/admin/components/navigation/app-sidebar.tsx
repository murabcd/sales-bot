"use client";

import {
	Clock,
	LayoutDashboard,
	Moon,
	Rss,
	Settings,
	Sun,
	Trophy,
	Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Icons } from "@/components/icons";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";

const navItems = [
	{ href: "/", label: "Overview", icon: LayoutDashboard },
	{ href: "/channels", label: "Channels", icon: Rss },
	{ href: "/sessions", label: "Sessions", icon: Users },
	{ href: "/cron", label: "Cron", icon: Clock },
	{ href: "/skills", label: "Skills", icon: Trophy },
	{ href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
	const pathname = usePathname();
	const { setTheme, theme, resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const activeTheme = mounted ? (resolvedTheme ?? theme) : undefined;
	const isDark = activeTheme === "dark";

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader className="h-14 border-b border-border justify-center">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton asChild>
							<Link href="/">
								<Icons.omniLogo className="size-4" />
								<span className="truncate font-semibold">Omni</span>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent className="mt-4">
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							{navItems.map((item) => {
								const isActive =
									(pathname === "/" && item.href === "/") ||
									(pathname !== "/" &&
										item.href !== "/" &&
										pathname.startsWith(item.href));
								const Icon = item.icon;
								return (
									<SidebarMenuItem key={item.href}>
										<SidebarMenuButton
											asChild
											isActive={isActive}
											tooltip={item.label}
										>
											<Link href={item.href}>
												<Icon className="size-4" />
												<span>{item.label}</span>
											</Link>
										</SidebarMenuButton>
									</SidebarMenuItem>
								);
							})}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							onClick={() => setTheme(isDark ? "light" : "dark")}
							tooltip={isDark ? "Light mode" : "Dark mode"}
							disabled={!mounted}
						>
							{!mounted ? (
								<Moon className="size-4" />
							) : isDark ? (
								<Sun className="size-4" />
							) : (
								<Moon className="size-4" />
							)}
							<span>{!mounted ? "Theme" : isDark ? "Light" : "Dark"} mode</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}
