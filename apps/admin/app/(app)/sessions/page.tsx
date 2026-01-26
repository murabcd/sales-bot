"use client";

import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGateway } from "@/components/gateway-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatAgo, toNumber } from "@/lib/format";
import { formatSessionTokens } from "@/lib/presenter";
import type {
	GatewaySessionRow,
	SessionsListResult,
} from "@/lib/sessions-types";

const THINK_LEVELS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
] as const;
const BINARY_THINK_LEVELS = ["inherit", "off", "on"] as const;
const VERBOSE_LEVELS = [
	{ value: "inherit", label: "inherit" },
	{ value: "off", label: "off (explicit)" },
	{ value: "on", label: "on" },
] as const;
const REASONING_LEVELS = ["inherit", "off", "on", "stream"] as const;

function normalizeProviderId(provider?: string | null): string {
	if (!provider) return "";
	const normalized = provider.trim().toLowerCase();
	if (normalized === "z.ai" || normalized === "z-ai") return "zai";
	return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
	return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
	return isBinaryThinkingProvider(provider)
		? BINARY_THINK_LEVELS
		: THINK_LEVELS;
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
	if (!isBinary) return value || "inherit";
	if (!value || value === "off") return value || "inherit";
	return "on";
}

function resolveThinkLevelPatchValue(
	value: string,
	isBinary: boolean,
): string | null {
	if (!value || value === "inherit") return null;
	if (!isBinary) return value;
	if (value === "on") return "low";
	return value;
}

export default function SessionsPage() {
	const { sessionsList, sessionsPatch, sessionsDelete } = useGateway();
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<SessionsListResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [activeMinutes, setActiveMinutes] = useState("");
	const [limit, setLimit] = useState("120");
	const [includeGlobal, setIncludeGlobal] = useState(true);
	const [includeUnknown, setIncludeUnknown] = useState(false);
	const [labelFilter, setLabelFilter] = useState("");
	const [spawnedByFilter, setSpawnedByFilter] = useState("");
	const [agentIdFilter, setAgentIdFilter] = useState("");

	const loadSessions = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const params: Record<string, unknown> = {
				includeGlobal,
				includeUnknown,
			};
			const activeValue = toNumber(activeMinutes, 0);
			const limitValue = toNumber(limit, 0);
			if (activeValue > 0) params.activeMinutes = activeValue;
			if (limitValue > 0) params.limit = limitValue;
			if (labelFilter.trim()) params.label = labelFilter.trim();
			if (spawnedByFilter.trim()) params.spawnedBy = spawnedByFilter.trim();
			if (agentIdFilter.trim()) params.agentId = agentIdFilter.trim();
			const res = (await sessionsList(params)) as
				| SessionsListResult
				| undefined;
			if (res) setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [
		activeMinutes,
		agentIdFilter,
		includeGlobal,
		includeUnknown,
		labelFilter,
		limit,
		sessionsList,
		spawnedByFilter,
	]);

	useEffect(() => {
		void loadSessions();
	}, [loadSessions]);

	const rows = result?.sessions ?? [];
	const storePath = result?.path ?? "";

	const handlePatch = useCallback(
		async (
			key: string,
			patch: {
				thinkingLevel?: string | null;
				verboseLevel?: string | null;
				reasoningLevel?: string | null;
			},
		) => {
			try {
				await sessionsPatch({ key, ...patch });
				await loadSessions();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[loadSessions, sessionsPatch],
	);

	const handleDelete = useCallback(
		async (key: string) => {
			setLoading(true);
			setError(null);
			try {
				await sessionsDelete({ key });
				await loadSessions();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[loadSessions, sessionsDelete],
	);

	const filters = useMemo(
		() => ({
			activeMinutes,
			agentIdFilter,
			limit,
			labelFilter,
			includeGlobal,
			includeUnknown,
			spawnedByFilter,
		}),
		[
			activeMinutes,
			agentIdFilter,
			includeGlobal,
			includeUnknown,
			labelFilter,
			limit,
			spawnedByFilter,
		],
	);

	return (
		<div className="space-y-6">
			<div className="grid gap-3 md:grid-cols-5">
				<div className="space-y-1 text-xs text-muted-foreground">
					<label htmlFor="active-minutes" className="block">
						Active within (minutes)
					</label>
					<Input
						id="active-minutes"
						value={filters.activeMinutes}
						onChange={(event) => setActiveMinutes(event.target.value)}
					/>
				</div>
				<div className="space-y-1 text-xs text-muted-foreground">
					<label htmlFor="limit" className="block">
						Limit
					</label>
					<Input
						id="limit"
						value={filters.limit}
						onChange={(event) => setLimit(event.target.value)}
					/>
				</div>
				<div className="space-y-1 text-xs text-muted-foreground">
					<label htmlFor="label-filter" className="block">
						Label
					</label>
					<Input
						id="label-filter"
						value={filters.labelFilter}
						onChange={(event) => setLabelFilter(event.target.value)}
					/>
				</div>
				<div className="space-y-1 text-xs text-muted-foreground">
					<label htmlFor="spawned-by-filter" className="block">
						Spawned by
					</label>
					<Input
						id="spawned-by-filter"
						value={filters.spawnedByFilter}
						onChange={(event) => setSpawnedByFilter(event.target.value)}
					/>
				</div>
				<div className="space-y-1 text-xs text-muted-foreground">
					<label htmlFor="agent-id-filter" className="block">
						Agent ID
					</label>
					<Input
						id="agent-id-filter"
						value={filters.agentIdFilter}
						onChange={(event) => setAgentIdFilter(event.target.value)}
					/>
				</div>
			</div>

			<div className="flex items-center gap-6 text-xs text-muted-foreground">
				<div className="flex items-center gap-2">
					<Checkbox
						id="include-global"
						checked={filters.includeGlobal}
						onCheckedChange={(checked) => setIncludeGlobal(checked === true)}
					/>
					<label htmlFor="include-global" className="cursor-pointer">
						Include global
					</label>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox
						id="include-unknown"
						checked={filters.includeUnknown}
						onCheckedChange={(checked) => setIncludeUnknown(checked === true)}
					/>
					<label htmlFor="include-unknown" className="cursor-pointer">
						Include unknown
					</label>
				</div>
			</div>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle className="size-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{storePath ? (
				<div className="text-xs text-muted-foreground">Store: {storePath}</div>
			) : null}

			<div className="rounded-md border border-border/60">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Key</TableHead>
							<TableHead>Label</TableHead>
							<TableHead>Kind</TableHead>
							<TableHead>Updated</TableHead>
							<TableHead>Tokens</TableHead>
							<TableHead>Thinking</TableHead>
							<TableHead>Verbose</TableHead>
							<TableHead>Reasoning</TableHead>
							<TableHead>Actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={9}
									className="text-sm text-muted-foreground"
								>
									No sessions found.
								</TableCell>
							</TableRow>
						) : (
							rows.map((row) => (
								<SessionRow
									key={row.key}
									row={row}
									loading={loading}
									onPatch={handlePatch}
									onDelete={handleDelete}
								/>
							))
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function SessionRow({
	row,
	onPatch,
	onDelete,
	loading,
}: {
	row: GatewaySessionRow;
	onPatch: (
		key: string,
		patch: {
			thinkingLevel?: string | null;
			verboseLevel?: string | null;
			reasoningLevel?: string | null;
		},
	) => void;
	onDelete: (key: string) => void;
	loading: boolean;
}) {
	const updated = row.updatedAt ? formatAgo(row.updatedAt) : "n/a";
	const rawThinking = row.thinkingLevel ?? "";
	const isBinary = isBinaryThinkingProvider(row.modelProvider);
	const thinking = resolveThinkLevelDisplay(rawThinking, isBinary);
	const thinkLevels = resolveThinkLevelOptions(row.modelProvider);
	const verbose = row.verboseLevel ?? "inherit";
	const reasoning = row.reasoningLevel ?? "inherit";
	const displayName = row.displayName ?? row.key;

	return (
		<TableRow>
			<TableCell className="font-mono text-xs">{displayName}</TableCell>
			<TableCell>{row.label ?? ""}</TableCell>
			<TableCell>
				<Badge>{row.kind}</Badge>
			</TableCell>
			<TableCell>{updated}</TableCell>
			<TableCell>{formatSessionTokens(row)}</TableCell>
			<TableCell>
				<Select
					value={thinking}
					onValueChange={(value) =>
						onPatch(row.key, {
							thinkingLevel: resolveThinkLevelPatchValue(value, isBinary),
						})
					}
					disabled={loading}
				>
					<SelectTrigger className="h-8 w-[140px]">
						<SelectValue placeholder="inherit" />
					</SelectTrigger>
					<SelectContent>
						{thinkLevels.map((level) => (
							<SelectItem key={level} value={level}>
								{level}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</TableCell>
			<TableCell>
				<Select
					value={verbose}
					onValueChange={(value) =>
						onPatch(row.key, {
							verboseLevel: value === "inherit" ? null : value,
						})
					}
					disabled={loading}
				>
					<SelectTrigger className="h-8 w-[160px]">
						<SelectValue placeholder="inherit" />
					</SelectTrigger>
					<SelectContent>
						{VERBOSE_LEVELS.map((level) => (
							<SelectItem key={level.value} value={level.value}>
								{level.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</TableCell>
			<TableCell>
				<Select
					value={reasoning}
					onValueChange={(value) =>
						onPatch(row.key, {
							reasoningLevel: value === "inherit" ? null : value,
						})
					}
					disabled={loading}
				>
					<SelectTrigger className="h-8 w-[140px]">
						<SelectValue placeholder="inherit" />
					</SelectTrigger>
					<SelectContent>
						{REASONING_LEVELS.map((level) => (
							<SelectItem key={level} value={level}>
								{level}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</TableCell>
			<TableCell>
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button variant="destructive" size="sm" disabled={loading}>
							Delete
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
							<AlertDialogDescription>
								This will delete the session. This action cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => onDelete(row.key)}
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}
