"use client";

import {
	Activity,
	AlertCircle,
	Clock,
	Loader2,
	Server,
	Shield,
	Trophy,
	Users,
} from "lucide-react";
import { useMemo } from "react";
import { useGateway } from "@/components/gateway-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Widget } from "@/components/ui/widget";

export function Widgets() {
	const {
		status,
		baseUrl,
		token,
		setBaseUrl,
		setToken,
		connect,
		loading,
		error,
	} = useGateway();
	const serviceName = useMemo(() => status?.serviceName ?? "omni", [status]);
	const isConnected = Boolean(status) && !error;
	const uptime = Math.round(status?.uptimeSeconds ?? 0);
	const instanceCount = status?.instanceId ? 1 : 0;

	return (
		<div className="space-y-6">
			{/* Unified 6-column grid for all widgets */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
				{/* Gateway access - spans 2 columns */}
				<Widget
					title="Gateway access"
					icon={<Shield className="size-4" />}
					description="Connection"
					className="lg:col-span-2"
				>
					<div className="space-y-3">
						<div className="grid grid-cols-2 gap-2">
							<Input
								value={baseUrl}
								placeholder="Gateway URL"
								onChange={(event) => setBaseUrl(event.target.value)}
								className="h-7 text-xs bg-transparent"
							/>
							<Input
								value={token}
								placeholder="Admin token"
								type="password"
								onChange={(event) => setToken(event.target.value)}
								className="h-7 text-xs bg-transparent"
							/>
							<Input
								placeholder="Password (optional)"
								type="password"
								className="h-7 text-xs bg-transparent"
							/>
							<Input
								placeholder="Session key"
								className="h-7 text-xs bg-transparent"
							/>
						</div>
						<div className="flex items-center gap-2">
							<Button size="sm" onClick={connect} disabled={loading}>
								{loading ? <Loader2 className="size-3 animate-spin" /> : null}
								Connect
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={connect}
								disabled={loading}
							>
								Refresh
							</Button>
						</div>
						{error ? (
							<Alert variant="destructive">
								<AlertCircle className="size-4" />
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</Widget>

				{/* Snapshot - spans 2 columns */}
				<Widget
					title="Snapshot"
					icon={<Activity className="size-4" />}
					description="Status"
					className="lg:col-span-2"
				>
					<div className="flex flex-col gap-2">
						<Badge
							variant={isConnected ? "success" : "error"}
							className="w-fit"
						>
							{isConnected ? "connected" : "disconnected"}
						</Badge>
						<div className="text-xs text-muted-foreground space-y-0.5">
							<p>uptime: {uptime}s</p>
							<p>tick interval: -</p>
							<p>last channels refresh: -</p>
						</div>
					</div>
				</Widget>

				{/* Instances - spans 2 columns */}
				<Widget
					title="Instances"
					icon={<Server className="size-4" />}
					description="Active runtimes"
					value={instanceCount}
					className="lg:col-span-2"
				>
					<div className="text-xs text-muted-foreground space-y-0.5">
						<p>primary: {status?.instanceId ?? "unknown"}</p>
						<p>region: {status?.region ?? "unknown"}</p>
					</div>
				</Widget>

				{/* Sessions - spans 2 columns */}
				<Widget
					title="Sessions"
					icon={<Users className="size-4" />}
					description="Live connections"
					value="-"
					className="lg:col-span-2"
				>
					<div className="text-xs text-muted-foreground space-y-0.5">
						<p>streaming: -</p>
						<p>history: -</p>
					</div>
				</Widget>

				{/* Cron next run - spans 2 columns */}
				<Widget
					title="Cron next run"
					icon={<Clock className="size-4" />}
					description="Scheduled automation"
					value={status?.cron?.enabled ? "scheduled" : "off"}
					className="lg:col-span-2"
				>
					<div className="text-xs text-muted-foreground space-y-0.5">
						<p>timezone: {status?.cron?.timezone ?? "-"}</p>
						<p>next: -</p>
					</div>
				</Widget>

				{/* Service - spans 2 columns */}
				<Widget
					title="Service"
					icon={<Trophy className="size-4" />}
					description="Runtime information"
					value={serviceName}
					className="lg:col-span-2"
				>
					<div className="text-xs text-muted-foreground space-y-0.5">
						<p>region: {status?.region ?? "unknown"}</p>
						<p>uptime: {uptime}s</p>
						<p>version: {status?.version ?? "unknown"}</p>
					</div>
				</Widget>
			</div>
		</div>
	);
}
