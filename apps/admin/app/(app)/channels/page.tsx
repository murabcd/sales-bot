"use client";

import { useCallback, useEffect, useState } from "react";
import { useGateway } from "@/components/gateway-provider";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ChannelEntry, ChannelsListResult } from "@/lib/channels-types";
import { formatAgo } from "@/lib/format";

function parseList(raw: string): string[] {
	return raw
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function formatList(values?: string[]) {
	if (!values || values.length === 0) return "";
	return values.join(", ");
}

export default function ChannelsPage() {
	const { channelsList, channelsPatch } = useGateway();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [includeDisabled, setIncludeDisabled] = useState(true);
	const [result, setResult] = useState<ChannelsListResult | null>(null);

	const loadChannels = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = (await channelsList({ includeDisabled })) as
				| ChannelsListResult
				| undefined;
			if (res) setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [channelsList, includeDisabled]);

	useEffect(() => {
		void loadChannels();
	}, [loadChannels]);

	const rows = result?.entries ?? [];

	const updateChannel = useCallback(
		async (
			key: string,
			patch: {
				enabled?: boolean;
				label?: string | null;
				requireMention?: boolean;
				allowUserIds?: string[];
				skillsAllowlist?: string[];
				skillsDenylist?: string[];
				systemPrompt?: string | null;
			},
		) => {
			try {
				await channelsPatch({ key, ...patch });
				await loadChannels();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[channelsPatch, loadChannels],
	);

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Checkbox
					id="include-disabled"
					checked={includeDisabled}
					onCheckedChange={(checked) => setIncludeDisabled(checked === true)}
				/>
				<label htmlFor="include-disabled" className="cursor-pointer">
					Include disabled
				</label>
			</div>

			{error ? (
				<div className="border border-rose-500/40 bg-rose-500/10 text-rose-400 text-sm px-4 py-2">
					{error}
				</div>
			) : null}

			<div className="rounded-md border border-border/60">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Title</TableHead>
							<TableHead>Label</TableHead>
							<TableHead>Kind</TableHead>
							<TableHead>Surface</TableHead>
							<TableHead>Last seen</TableHead>
							<TableHead>Enabled</TableHead>
							<TableHead>Require mention</TableHead>
							<TableHead>Allow user IDs</TableHead>
							<TableHead>Skills allowlist</TableHead>
							<TableHead>Skills denylist</TableHead>
							<TableHead>System prompt</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={11}
									className="text-sm text-muted-foreground"
								>
									No channels found.
								</TableCell>
							</TableRow>
						) : (
							rows.map((row) => (
								<ChannelRow
									key={row.key}
									row={row}
									loading={loading}
									onPatch={updateChannel}
								/>
							))
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function ChannelRow({
	row,
	onPatch,
	loading,
}: {
	row: ChannelEntry;
	onPatch: (
		key: string,
		patch: {
			enabled?: boolean;
			label?: string | null;
			requireMention?: boolean;
			allowUserIds?: string[];
			skillsAllowlist?: string[];
			skillsDenylist?: string[];
			systemPrompt?: string | null;
		},
	) => void;
	loading: boolean;
}) {
	const updated = row.lastSeenAt ? formatAgo(row.lastSeenAt) : "n/a";
	return (
		<TableRow>
			<TableCell className="font-mono text-xs">
				{row.title ?? row.chatId}
			</TableCell>
			<TableCell>
				<Input
					value={row.label ?? ""}
					placeholder="Label"
					onChange={(event) =>
						onPatch(row.key, { label: event.target.value || null })
					}
					disabled={loading}
					className="h-8"
				/>
			</TableCell>
			<TableCell>
				<Badge>{row.kind}</Badge>
			</TableCell>
			<TableCell>{row.surface}</TableCell>
			<TableCell>{updated}</TableCell>
			<TableCell>
				<Checkbox
					checked={row.enabled !== false}
					onCheckedChange={(checked) =>
						onPatch(row.key, { enabled: checked === true })
					}
					disabled={loading}
				/>
			</TableCell>
			<TableCell>
				<Checkbox
					checked={row.requireMention === true}
					onCheckedChange={(checked) =>
						onPatch(row.key, { requireMention: checked === true })
					}
					disabled={loading}
				/>
			</TableCell>
			<TableCell>
				<Input
					value={formatList(row.allowUserIds)}
					placeholder="123,456"
					onChange={(event) =>
						onPatch(row.key, { allowUserIds: parseList(event.target.value) })
					}
					disabled={loading}
					className="h-8"
				/>
			</TableCell>
			<TableCell>
				<Input
					value={formatList(row.skillsAllowlist)}
					placeholder="skill_a, skill_b"
					onChange={(event) =>
						onPatch(row.key, {
							skillsAllowlist: parseList(event.target.value),
						})
					}
					disabled={loading}
					className="h-8"
				/>
			</TableCell>
			<TableCell>
				<Input
					value={formatList(row.skillsDenylist)}
					placeholder="skill_x, skill_y"
					onChange={(event) =>
						onPatch(row.key, {
							skillsDenylist: parseList(event.target.value),
						})
					}
					disabled={loading}
					className="h-8"
				/>
			</TableCell>
			<TableCell>
				<Input
					value={row.systemPrompt ?? ""}
					placeholder="Additional system prompt"
					onChange={(event) =>
						onPatch(row.key, { systemPrompt: event.target.value || null })
					}
					disabled={loading}
					className="h-8"
				/>
			</TableCell>
		</TableRow>
	);
}
