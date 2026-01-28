"use client";

import { AlertCircle, ChevronRight, Loader2, Package } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGateway } from "@/components/gateway-provider";
import { useBreadcrumb } from "@/components/navigation/breadcrumb-context";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SkillStatusEntry, SkillStatusReport } from "@/lib/skills-types";

type SkillMessage = {
	kind: "success" | "error";
	message: string;
};

type SkillMessageMap = Record<string, SkillMessage>;

type ServerGroup = {
	server: string;
	displayName: string;
	skills: SkillStatusEntry[];
	eligibleCount: number;
	disabledCount: number;
	sources: string[];
};

function normalizeServerId(server?: string | null) {
	const normalized = server?.trim().toLowerCase();
	if (!normalized) return "unknown";
	if (normalized === "yandex-tracker" || normalized === "tracker") {
		return "yandex-tracker";
	}
	return normalized;
}

function formatServerDisplayName(serverId: string) {
	if (serverId === "yandex-tracker") return "Yandex Tracker";
	if (serverId === "posthog") return "PostHog";
	if (serverId === "yandex-wiki") return "Yandex Wiki";
	if (serverId === "google-public") return "Google Drive";
	const withSpaces = serverId.replaceAll("-", " ").replaceAll("_", " ");
	return withSpaces
		.split(" ")
		.map((word) =>
			word ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : "",
		)
		.join(" ");
}

function clamp(text: string, max = 140) {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}...`;
}

function ServerCard({
	group,
	onClick,
}: {
	group: ServerGroup;
	onClick: () => void;
}) {
	const totalCount = group.skills.length;
	const uniqueSources = [...new Set(group.sources)];

	return (
		<Card className="cursor-pointer group" onClick={onClick}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between">
					<div className="space-y-0.5">
						<div className="flex items-center gap-2">
							<Package className="h-4 w-4 text-muted-foreground" />
							<CardTitle className="text-base">{group.displayName}</CardTitle>
						</div>
						<CardDescription className="text-xs">
							{totalCount} skill{totalCount !== 1 ? "s" : ""}
						</CardDescription>
					</div>
					<ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
				</div>
			</CardHeader>
			<CardContent className="pt-0">
				<div className="flex flex-wrap gap-2 mb-3">
					{uniqueSources.slice(0, 3).map((source) => (
						<Badge key={source} variant="muted" className="text-xs">
							{source}
						</Badge>
					))}
					{uniqueSources.length > 3 && (
						<Badge variant="muted" className="text-xs">
							+{uniqueSources.length - 3} more
						</Badge>
					)}
				</div>
				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span className="flex items-center gap-1">
						<span className="h-2 w-2 rounded-full bg-emerald-500" />
						{group.eligibleCount} eligible
					</span>
					{group.disabledCount > 0 && (
						<span className="flex items-center gap-1">
							<span className="h-2 w-2 rounded-full bg-amber-500" />
							{group.disabledCount} disabled
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function SkillCard({
	skill,
	busyKey,
	message,
	onToggle,
	onInstall,
}: {
	skill: SkillStatusEntry;
	busyKey: string | null;
	message?: SkillMessage;
	onToggle: () => void;
	onInstall: (installId: string) => void;
}) {
	const missing = [
		...skill.missing.bins.map((value) => `bin:${value}`),
		...skill.missing.env.map((value) => `env:${value}`),
		...skill.missing.config.map((value) => `config:${value}`),
		...skill.missing.os.map((value) => `os:${value}`),
	];
	const reasons: string[] = [];
	if (skill.disabled) reasons.push("disabled");
	if (skill.blockedByAllowlist) reasons.push("blocked by allowlist");
	const canInstall = skill.install.length > 0 && skill.missing.bins.length > 0;
	const isBusy = busyKey === skill.skillKey;

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-2 flex-1 min-w-0">
						<CardTitle className="text-base">
							{skill.emoji ? `${skill.emoji} ` : ""}
							{skill.name}
						</CardTitle>
						{skill.description && (
							<CardDescription className="text-sm">
								{clamp(skill.description, 160)}
							</CardDescription>
						)}
						<div className="flex flex-wrap gap-2">
							<Badge variant="muted">{skill.source}</Badge>
							<Badge variant={skill.eligible ? "success" : "warning"}>
								{skill.eligible ? "eligible" : "blocked"}
							</Badge>
							{skill.disabled && <Badge variant="warning">disabled</Badge>}
						</div>
					</div>
					<div className="flex flex-wrap gap-2 sm:flex-shrink-0">
						<Button
							size="sm"
							variant="outline"
							onClick={onToggle}
							disabled={isBusy}
						>
							{isBusy && <Loader2 className="size-3 animate-spin mr-1" />}
							{skill.disabled ? "Enable" : "Disable"}
						</Button>
						{canInstall && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => onInstall(skill.install[0].id)}
								disabled={isBusy}
							>
								{isBusy && <Loader2 className="size-3 animate-spin mr-1" />}
								{skill.install[0].label}
							</Button>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent className="pt-0">
				{missing.length > 0 && (
					<p className="text-xs text-muted-foreground mb-1">
						Missing: {missing.join(", ")}
					</p>
				)}
				{reasons.length > 0 && (
					<p className="text-xs text-muted-foreground mb-1">
						Reason: {reasons.join(", ")}
					</p>
				)}
				{message && (
					<p
						className={
							message.kind === "error"
								? "text-xs text-rose-400"
								: "text-xs text-emerald-400"
						}
					>
						{message.message}
					</p>
				)}
				{skill.missing.env.length > 0 && (
					<p className="text-xs text-muted-foreground mt-2">
						Set global env values to satisfy requirements.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

export default function SkillsPage() {
	const { skillsStatus, skillsUpdate, skillsInstall } = useGateway();
	const { setSegments, clearSegments } = useBreadcrumb();
	const [, setLoading] = useState(false);
	const [report, setReport] = useState<SkillStatusReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [messages, setMessages] = useState<SkillMessageMap>({});
	const [selectedServer, setSelectedServer] = useState<string | null>(null);
	const loadingRef = useRef(false);

	const skills = report?.skills ?? [];

	// Group skills by server
	const serverGroups = useMemo(() => {
		const sortRank = (serverId: string) => {
			if (serverId === "yandex-tracker") return 0;
			if (serverId === "yandex-wiki") return 1;
			if (serverId === "web") return 90;
			if (serverId === "memory") return 91;
			return 2;
		};
		const groups = new Map<string, SkillStatusEntry[]>();
		for (const skill of skills) {
			const key = normalizeServerId(skill.server);
			const entry = groups.get(key);
			if (entry) entry.push(skill);
			else groups.set(key, [skill]);
		}

		return Array.from(groups.entries())
			.map(
				([server, serverSkills]): ServerGroup => ({
					server,
					displayName: formatServerDisplayName(server),
					skills: serverSkills,
					eligibleCount: serverSkills.filter((s) => s.eligible).length,
					disabledCount: serverSkills.filter((s) => s.disabled).length,
					sources: serverSkills.map((s) => s.source),
				}),
			)
			.sort((a, b) => {
				const rankDiff = sortRank(a.server) - sortRank(b.server);
				if (rankDiff !== 0) return rankDiff;
				return b.skills.length - a.skills.length;
			});
	}, [skills]);

	// Filter server groups for overview
	const filteredGroups = useMemo(() => {
		const trimmed = filter.trim().toLowerCase();
		if (!trimmed) return serverGroups;
		return serverGroups.filter(
			(group) =>
				group.server.toLowerCase().includes(trimmed) ||
				group.displayName.toLowerCase().includes(trimmed) ||
				group.skills.some(
					(skill) =>
						skill.name.toLowerCase().includes(trimmed) ||
						skill.description.toLowerCase().includes(trimmed) ||
						skill.source.toLowerCase().includes(trimmed),
				),
		);
	}, [filter, serverGroups]);

	// Get skills for selected server, with filtering
	const selectedGroupSkills = useMemo(() => {
		if (!selectedServer) return [];
		const group = serverGroups.find((g) => g.server === selectedServer);
		if (!group) return [];

		const trimmed = filter.trim().toLowerCase();
		if (!trimmed) return group.skills;

		return group.skills.filter(
			(skill) =>
				skill.name.toLowerCase().includes(trimmed) ||
				skill.description.toLowerCase().includes(trimmed) ||
				skill.source.toLowerCase().includes(trimmed),
		);
	}, [selectedServer, serverGroups, filter]);

	const setSkillMessage = (skillKey: string, message?: SkillMessage) => {
		setMessages((prev) => {
			const next = { ...prev };
			if (message) next[skillKey] = message;
			else delete next[skillKey];
			return next;
		});
	};

	const loadSkills = useCallback(
		async (clearMessages = false) => {
			if (loadingRef.current) return;
			loadingRef.current = true;
			setLoading(true);
			setError(null);
			if (clearMessages) setMessages({});
			try {
				const res = await skillsStatus();
				setReport(res);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				loadingRef.current = false;
				setLoading(false);
			}
		},
		[skillsStatus],
	);

	useEffect(() => {
		void loadSkills();
	}, [loadSkills]);

	const updateSkillEnabled = async (skill: SkillStatusEntry) => {
		setBusyKey(skill.skillKey);
		setError(null);
		try {
			await skillsUpdate({
				skillKey: skill.skillKey,
				enabled: skill.disabled,
			});
			await loadSkills();
			setSkillMessage(skill.skillKey, {
				kind: "success",
				message: skill.disabled ? "Skill enabled" : "Skill disabled",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setSkillMessage(skill.skillKey, { kind: "error", message });
		} finally {
			setBusyKey(null);
		}
	};

	const installSkill = async (skill: SkillStatusEntry, installId: string) => {
		setBusyKey(skill.skillKey);
		setError(null);
		try {
			const result = await skillsInstall({
				name: skill.name,
				installId,
				timeoutMs: 120_000,
			});
			await loadSkills();
			setSkillMessage(skill.skillKey, {
				kind: "success",
				message: result?.message ?? "Installed",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setSkillMessage(skill.skillKey, { kind: "error", message });
		} finally {
			setBusyKey(null);
		}
	};

	const handleBackClick = useCallback(() => {
		setSelectedServer(null);
		setFilter("");
	}, []);

	// Update breadcrumbs when selected server changes
	useEffect(() => {
		if (selectedServer) {
			setSegments([
				{
					label:
						selectedServer.charAt(0).toUpperCase() + selectedServer.slice(1),
					onClick: handleBackClick,
				},
			]);
		} else {
			clearSegments();
		}
		return () => clearSegments();
	}, [selectedServer, setSegments, clearSegments, handleBackClick]);

	// Detail view for a selected server
	if (selectedServer) {
		const group = serverGroups.find((g) => g.server === selectedServer);

		return (
			<div className="space-y-6">
				<div className="flex flex-col gap-3 md:flex-row md:items-center">
					<div className="flex-1 max-w-[420px]">
						<Input
							placeholder="Search skills..."
							className="bg-transparent"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
						/>
					</div>
					<div className="text-xs text-muted-foreground">
						{selectedGroupSkills.length} of {group?.skills.length ?? 0} skills
					</div>
				</div>

				{error && (
					<Alert variant="destructive">
						<AlertCircle className="size-4" />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}

				{selectedGroupSkills.length === 0 ? (
					<p className="text-sm text-muted-foreground">No skills found.</p>
				) : (
					<div className="space-y-3 max-w-3xl">
						{selectedGroupSkills.map((skill) => (
							<SkillCard
								key={skill.skillKey}
								skill={skill}
								busyKey={busyKey}
								message={messages[skill.skillKey]}
								onToggle={() => updateSkillEnabled(skill)}
								onInstall={(installId) => installSkill(skill, installId)}
							/>
						))}
					</div>
				)}
			</div>
		);
	}

	// Overview view with server cards
	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-3 md:flex-row md:items-center">
				<div className="flex-1 max-w-[420px]">
					<Input
						placeholder="Search integrations or skills..."
						className="bg-transparent"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
				</div>
				<div className="text-xs text-muted-foreground">
					{filteredGroups.length} integration
					{filteredGroups.length !== 1 ? "s" : ""} ({skills.length} total
					skills)
				</div>
			</div>

			{error && (
				<Alert variant="destructive">
					<AlertCircle className="size-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			{filteredGroups.length === 0 ? (
				<div className="text-center py-12">
					<Package className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
					<p className="text-sm text-muted-foreground">
						No integrations found.
					</p>
					{filter && (
						<p className="text-xs text-muted-foreground mt-1">
							Try a different search term.
						</p>
					)}
				</div>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{filteredGroups.map((group) => (
						<ServerCard
							key={group.server}
							group={group}
							onClick={() => setSelectedServer(group.server)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
