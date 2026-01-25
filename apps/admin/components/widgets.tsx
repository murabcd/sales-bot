"use client";

import { Clock, FileText, Play, Plug, Server, Shield } from "lucide-react";
import { useMemo } from "react";
import { CronRunner } from "@/components/cron-runner";
import { useGateway } from "@/components/gateway-provider";
import { Badge } from "@/components/ui/badge";
import { MetricCard, Widget, WidgetGrid } from "@/components/ui/widget";

export function Widgets() {
	const { status, runCron } = useGateway();
	const serviceName = useMemo(() => status?.serviceName ?? "omni", [status]);

	return (
		<div className="space-y-6">
			{/* Widgets Grid - 4 columns like midday */}
			<WidgetGrid>
				<Widget
					title="Service"
					icon={<Server className="size-4" />}
					description="Runtime information"
					value={serviceName}
					actions={`v${status?.version ?? "unknown"}`}
				>
					<div className="text-xs text-[#666666] space-y-0.5">
						<p>region: {status?.region ?? "unknown"}</p>
						<p>uptime: {Math.round(status?.uptimeSeconds ?? 0)}s</p>
					</div>
				</Widget>

				<Widget
					title="Admin auth"
					icon={<Shield className="size-4" />}
					description="Authentication settings"
				>
					<div className="flex flex-col gap-2">
						<Badge
							className={
								status?.admin?.authRequired
									? "w-fit border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
									: "w-fit border-rose-500/40 text-rose-400 bg-rose-500/10"
							}
						>
							{status?.admin?.authRequired ? "enabled" : "disabled"}
						</Badge>
						<p className="text-xs text-[#666666]">
							allowlist:{" "}
							{status?.admin?.allowlist?.length
								? status.admin.allowlist.join(", ")
								: "-"}
						</p>
					</div>
				</Widget>

				<Widget
					title="Cron"
					icon={<Clock className="size-4" />}
					description="Scheduled automation"
				>
					<div className="flex flex-col gap-2">
						<Badge
							className={
								status?.cron?.enabled
									? "w-fit border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
									: "w-fit border-rose-500/40 text-rose-400 bg-rose-500/10"
							}
						>
							{status?.cron?.enabled ? "enabled" : "disabled"}
						</Badge>
						<div className="text-xs text-[#666666] space-y-0.5">
							<p>timezone: {status?.cron?.timezone ?? "-"}</p>
							<p>filter: {status?.cron?.sprintFilter ?? "-"}</p>
						</div>
					</div>
				</Widget>

				<Widget
					title="Summary"
					icon={<FileText className="size-4" />}
					description="Report generation"
				>
					<div className="flex flex-col gap-2">
						<Badge
							className={
								status?.summary?.enabled
									? "w-fit border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
									: "w-fit border-rose-500/40 text-rose-400 bg-rose-500/10"
							}
						>
							{status?.summary?.enabled ? "enabled" : "disabled"}
						</Badge>
						<p className="text-xs text-[#666666]">
							model: {status?.summary?.model ?? "-"}
						</p>
					</div>
				</Widget>
			</WidgetGrid>

			{/* Larger cards section */}
			<div className="grid gap-4 md:grid-cols-2">
				<MetricCard
					title="Gateway plugins"
					value={status?.gateway?.plugins?.active?.length ?? 0}
					footer={
						<span>
							{status?.gateway?.plugins?.configured?.length ?? 0} configured
						</span>
					}
				>
					<div className="space-y-2 text-sm text-[#666666]">
						<div className="flex items-center gap-2">
							<Plug className="size-4" />
							<span>Active plugins</span>
						</div>
						<p className="text-xs">
							{status?.gateway?.plugins?.active?.length
								? status.gateway.plugins.active.join(", ")
								: "No active plugins"}
						</p>
						{status?.gateway?.plugins?.allowlist?.length ? (
							<p className="text-xs">
								allowlist: {status.gateway.plugins.allowlist.join(", ")}
							</p>
						) : null}
						{status?.gateway?.plugins?.denylist?.length ? (
							<p className="text-xs">
								denylist: {status.gateway.plugins.denylist.join(", ")}
							</p>
						) : null}
					</div>
				</MetricCard>

				<MetricCard title="Manual run">
					<div className="space-y-4">
						<div className="flex items-center gap-2 text-sm text-[#666666]">
							<Play className="size-4" />
							<span>Run daily report manually</span>
						</div>
						<CronRunner runCron={runCron} />
					</div>
				</MetricCard>
			</div>
		</div>
	);
}
