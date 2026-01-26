"use client";

import { AlertCircle, Clock, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGateway } from "@/components/gateway-provider";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { CronJob, CronRunLogEntry, CronStatus } from "@/lib/cron-types";
import { formatDurationMs, formatMs, toNumber } from "@/lib/format";
import {
	formatCronPayload,
	formatCronSchedule,
	formatCronState,
	formatNextRun,
} from "@/lib/presenter";

type CronFormState = {
	name: string;
	description: string;
	agentId: string;
	enabled: boolean;
	scheduleKind: "at" | "every" | "cron";
	scheduleAt: string;
	everyAmount: string;
	everyUnit: "minutes" | "hours" | "days";
	cronExpr: string;
	cronTz: string;
	sessionTarget: "main" | "isolated";
	wakeMode: "next-heartbeat" | "now";
	payloadKind: "systemEvent" | "agentTurn" | "dailyStatus";
	payloadText: string;
	payloadModel: string;
	deliver: boolean;
	channel:
		| "last"
		| "whatsapp"
		| "telegram"
		| "discord"
		| "slack"
		| "signal"
		| "imessage"
		| "msteams";
	to: string;
	timeoutSeconds: string;
	postToMainPrefix: string;
	postToMainMode: "summary" | "full";
	postToMainMaxChars: string;
};

const DEFAULT_FORM: CronFormState = {
	name: "",
	description: "",
	agentId: "",
	enabled: true,
	scheduleKind: "every",
	scheduleAt: "",
	everyAmount: "30",
	everyUnit: "minutes",
	cronExpr: "0 7 * * *",
	cronTz: "",
	sessionTarget: "main",
	wakeMode: "next-heartbeat",
	payloadKind: "systemEvent",
	payloadText: "",
	payloadModel: "",
	deliver: false,
	channel: "last",
	to: "",
	timeoutSeconds: "",
	postToMainPrefix: "",
	postToMainMode: "summary",
	postToMainMaxChars: "",
};

function buildCronSchedule(form: CronFormState) {
	if (form.scheduleKind === "at") {
		const ms = Date.parse(form.scheduleAt);
		if (!Number.isFinite(ms)) throw new Error("Invalid run time.");
		return { kind: "at" as const, atMs: ms };
	}
	if (form.scheduleKind === "every") {
		const amount = toNumber(form.everyAmount, 0);
		if (amount <= 0) throw new Error("Invalid interval amount.");
		const unit = form.everyUnit;
		const mult =
			unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
		return { kind: "every" as const, everyMs: amount * mult };
	}
	const expr = form.cronExpr.trim();
	if (!expr) throw new Error("Cron expression required.");
	return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
}

function buildCronPayload(form: CronFormState) {
	if (form.payloadKind === "systemEvent") {
		const text = form.payloadText.trim();
		if (!text) throw new Error("System event text required.");
		return { kind: "systemEvent" as const, text };
	}
	if (form.payloadKind === "dailyStatus") {
		const to = form.to.trim();
		return { kind: "dailyStatus" as const, to: to || undefined };
	}
	const message = form.payloadText.trim();
	if (!message) throw new Error("Agent message required.");
	const payload: {
		kind: "agentTurn";
		message: string;
		model?: string;
		deliver?: boolean;
		channel?:
			| "last"
			| "whatsapp"
			| "telegram"
			| "discord"
			| "slack"
			| "signal"
			| "imessage"
			| "msteams";
		to?: string;
		timeoutSeconds?: number;
	} = { kind: "agentTurn", message };
	if (form.payloadModel.trim()) payload.model = form.payloadModel.trim();
	if (form.deliver) payload.deliver = true;
	if (form.channel) payload.channel = form.channel;
	if (form.to.trim()) payload.to = form.to.trim();
	const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
	if (timeoutSeconds > 0) payload.timeoutSeconds = timeoutSeconds;
	return payload;
}

export default function CronPage() {
	const {
		cronStatus,
		cronList,
		cronAdd,
		cronUpdate,
		cronRemove,
		cronRun,
		cronRuns,
	} = useGateway();
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState<CronStatus | null>(null);
	const [jobs, setJobs] = useState<CronJob[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [form, setForm] = useState<CronFormState>(() => ({ ...DEFAULT_FORM }));
	const [runsJobId, setRunsJobId] = useState<string | null>(null);
	const [runs, setRuns] = useState<CronRunLogEntry[]>([]);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [nextStatus, list] = await Promise.all([
				cronStatus(),
				cronList({ includeDisabled: true }),
			]);
			setStatus(nextStatus as CronStatus);
			setJobs(Array.isArray(list.jobs) ? (list.jobs as CronJob[]) : []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [cronList, cronStatus]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const addJob = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const schedule = buildCronSchedule(form);
			const payload = buildCronPayload(form);
			if (
				form.sessionTarget === "main" &&
				payload.kind !== "systemEvent" &&
				payload.kind !== "dailyStatus"
			) {
				throw new Error(
					'Main jobs require payload kind "systemEvent" or "dailyStatus".',
				);
			}
			if (form.sessionTarget === "isolated" && payload.kind !== "agentTurn") {
				throw new Error('Isolated jobs require payload kind "agentTurn".');
			}
			const agentId = form.agentId.trim();
			const job = {
				name: form.name.trim(),
				description: form.description.trim() || undefined,
				agentId: agentId || undefined,
				enabled: form.enabled,
				schedule,
				sessionTarget: form.sessionTarget,
				wakeMode: form.wakeMode,
				payload,
				isolation:
					form.sessionTarget === "isolated" &&
					(form.postToMainPrefix.trim() ||
						form.postToMainMode ||
						form.postToMainMaxChars)
						? {
								postToMainPrefix: form.postToMainPrefix.trim() || "Cron:",
								postToMainMode: form.postToMainMode,
								postToMainMaxChars:
									toNumber(form.postToMainMaxChars, 0) || undefined,
							}
						: undefined,
			};
			if (!job.name) throw new Error("Name required.");
			await cronAdd(job);
			setForm((prev) => ({
				...prev,
				name: "",
				description: "",
				payloadText: "",
			}));
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [busy, cronAdd, form, refresh]);

	const toggleJob = useCallback(
		async (job: CronJob, enabled: boolean) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			try {
				await cronUpdate({ id: job.id, patch: { enabled } });
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[busy, cronUpdate, refresh],
	);

	const runJob = useCallback(
		async (job: CronJob) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			try {
				await cronRun({ id: job.id, mode: "force" });
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[busy, cronRun, refresh],
	);

	const removeJob = useCallback(
		async (job: CronJob) => {
			if (busy) return;
			const confirmed = window.confirm(`Remove "${job.name}"?`);
			if (!confirmed) return;
			setBusy(true);
			setError(null);
			try {
				await cronRemove({ id: job.id });
				if (runsJobId === job.id) {
					setRunsJobId(null);
					setRuns([]);
				}
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[busy, cronRemove, refresh, runsJobId],
	);

	const loadRuns = useCallback(
		async (jobId: string) => {
			setRunsJobId(jobId);
			setError(null);
			try {
				const result = await cronRuns({ id: jobId, limit: 50 });
				setRuns(
					Array.isArray(result.entries)
						? (result.entries as CronRunLogEntry[])
						: [],
				);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[cronRuns],
	);

	const selectedRunsLabel = useMemo(
		() => (runsJobId ? runsJobId : "(select a job)"),
		[runsJobId],
	);

	return (
		<div className="space-y-6 pt-6">
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Clock className="size-4 text-primary" />
						<h1 className="text-lg font-medium">Cron</h1>
					</div>
					<p className="text-sm text-[#666666] max-w-[720px]">
						Scheduled automation status, targets, and job configuration.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={refresh}
					disabled={loading}
				>
					{loading ? <Loader2 className="size-4 animate-spin" /> : null}
					Refresh
				</Button>
			</div>

			<section className="grid gap-4 md:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Scheduler</CardTitle>
						<CardDescription>
							Gateway-owned cron scheduler status.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-3 gap-4 text-sm">
							<div>
								<div className="text-xs text-[#666666]">Enabled</div>
								<div>{status ? (status.enabled ? "Yes" : "No") : "n/a"}</div>
							</div>
							<div>
								<div className="text-xs text-[#666666]">Jobs</div>
								<div>{status?.jobs ?? "n/a"}</div>
							</div>
							<div>
								<div className="text-xs text-[#666666]">Next wake</div>
								<div>{formatNextRun(status?.nextWakeAtMs ?? null)}</div>
							</div>
						</div>
						{error ? (
							<Alert variant="destructive" className="mt-3">
								<AlertCircle className="size-4" />
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-base">New Job</CardTitle>
						<CardDescription>
							Create a scheduled wakeup or agent run.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="grid gap-3 md:grid-cols-2">
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-name" className="block">
									Name
								</label>
								<Input
									id="cron-name"
									value={form.name}
									onChange={(event) =>
										setForm((prev) => ({ ...prev, name: event.target.value }))
									}
								/>
							</div>
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-description" className="block">
									Description
								</label>
								<Input
									id="cron-description"
									value={form.description}
									onChange={(event) =>
										setForm((prev) => ({
											...prev,
											description: event.target.value,
										}))
									}
								/>
							</div>
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-agent-id" className="block">
									Agent ID
								</label>
								<Input
									id="cron-agent-id"
									placeholder="default"
									value={form.agentId}
									onChange={(event) =>
										setForm((prev) => ({
											...prev,
											agentId: event.target.value,
										}))
									}
								/>
							</div>
							<div className="flex items-center gap-2 text-xs text-[#666666]">
								<Checkbox
									id="cron-enabled"
									checked={form.enabled}
									onCheckedChange={(checked) =>
										setForm((prev) => ({
											...prev,
											enabled: checked === true,
										}))
									}
								/>
								<label htmlFor="cron-enabled" className="cursor-pointer">
									Enabled
								</label>
							</div>
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-schedule" className="block">
									Schedule
								</label>
								<Select
									value={form.scheduleKind}
									onValueChange={(value) =>
										setForm((prev) => ({
											...prev,
											scheduleKind: value as CronFormState["scheduleKind"],
										}))
									}
								>
									<SelectTrigger id="cron-schedule">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="every">Every</SelectItem>
										<SelectItem value="at">At</SelectItem>
										<SelectItem value="cron">Cron</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>

						{form.scheduleKind === "at" ? (
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-run-at" className="block">
									Run at
								</label>
								<Input
									id="cron-run-at"
									type="datetime-local"
									value={form.scheduleAt}
									onChange={(event) =>
										setForm((prev) => ({
											...prev,
											scheduleAt: event.target.value,
										}))
									}
								/>
							</div>
						) : null}
						{form.scheduleKind === "every" ? (
							<div className="grid gap-3 md:grid-cols-2">
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-every-amount" className="block">
										Every
									</label>
									<Input
										id="cron-every-amount"
										value={form.everyAmount}
										onChange={(event) =>
											setForm((prev) => ({
												...prev,
												everyAmount: event.target.value,
											}))
										}
									/>
								</div>
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-every-unit" className="block">
										Unit
									</label>
									<Select
										value={form.everyUnit}
										onValueChange={(value) =>
											setForm((prev) => ({
												...prev,
												everyUnit: value as CronFormState["everyUnit"],
											}))
										}
									>
										<SelectTrigger id="cron-every-unit">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="minutes">Minutes</SelectItem>
											<SelectItem value="hours">Hours</SelectItem>
											<SelectItem value="days">Days</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>
						) : null}
						{form.scheduleKind === "cron" ? (
							<div className="grid gap-3 md:grid-cols-2">
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-expr" className="block">
										Expression
									</label>
									<Input
										id="cron-expr"
										value={form.cronExpr}
										onChange={(event) =>
											setForm((prev) => ({
												...prev,
												cronExpr: event.target.value,
											}))
										}
									/>
								</div>
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-tz" className="block">
										Timezone (optional)
									</label>
									<Input
										id="cron-tz"
										value={form.cronTz}
										onChange={(event) =>
											setForm((prev) => ({
												...prev,
												cronTz: event.target.value,
											}))
										}
									/>
								</div>
							</div>
						) : null}

						<div className="grid gap-3 md:grid-cols-2">
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-session" className="block">
									Session
								</label>
								<Select
									value={form.sessionTarget}
									onValueChange={(value) =>
										setForm((prev) => ({
											...prev,
											sessionTarget: value as CronFormState["sessionTarget"],
										}))
									}
								>
									<SelectTrigger id="cron-session">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="main">Main</SelectItem>
										<SelectItem value="isolated">Isolated</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-wake-mode" className="block">
									Wake mode
								</label>
								<Select
									value={form.wakeMode}
									onValueChange={(value) =>
										setForm((prev) => ({
											...prev,
											wakeMode: value as CronFormState["wakeMode"],
										}))
									}
								>
									<SelectTrigger id="cron-wake-mode">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="next-heartbeat">
											Next heartbeat
										</SelectItem>
										<SelectItem value="now">Now</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-payload" className="block">
									Payload
								</label>
								<Select
									value={form.payloadKind}
									onValueChange={(value) =>
										setForm((prev) => ({
											...prev,
											payloadKind: value as CronFormState["payloadKind"],
										}))
									}
								>
									<SelectTrigger id="cron-payload">
										<SelectValue />
									</SelectTrigger>
								<SelectContent>
									<SelectItem value="systemEvent">System event</SelectItem>
									<SelectItem value="agentTurn">Agent turn</SelectItem>
									<SelectItem value="dailyStatus">Daily status</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>

						{form.payloadKind !== "dailyStatus" ? (
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-payload-text" className="block">
									{form.payloadKind === "systemEvent"
										? "System text"
										: "Agent message"}
								</label>
								<Textarea
									id="cron-payload-text"
									rows={4}
									value={form.payloadText}
									onChange={(event) =>
										setForm((prev) => ({
											...prev,
											payloadText: event.target.value,
										}))
									}
								/>
							</div>
						) : (
							<div className="rounded-md border border-dashed border-[#e4e4e7] px-3 py-2 text-xs text-[#666666]">
								Uses Settings → Cron & summary for Jira + OpenAI config.
							</div>
						)}

						{form.payloadKind === "agentTurn" ||
						form.payloadKind === "dailyStatus" ? (
							<div className="space-y-1 text-xs text-[#666666]">
								<label htmlFor="cron-to" className="block">
									To
								</label>
								<Input
									id="cron-to"
									placeholder={
										form.payloadKind === "dailyStatus"
											? "Override chat id (optional)"
											: "+1555… or chat id"
									}
									value={form.to}
									onChange={(event) =>
										setForm((prev) => ({ ...prev, to: event.target.value }))
									}
								/>
							</div>
						) : null}

						{form.payloadKind === "agentTurn" ? (
							<div className="grid gap-3 md:grid-cols-2">
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-model" className="block">
										Model override
									</label>
									<Input
										id="cron-model"
										placeholder="provider/model or alias"
										value={form.payloadModel}
										onChange={(event) =>
											setForm((prev) => ({
												...prev,
												payloadModel: event.target.value,
											}))
										}
									/>
								</div>
								<div className="flex items-center gap-2 text-xs text-[#666666]">
									<Checkbox
										id="cron-deliver"
										checked={form.deliver}
										onCheckedChange={(checked) =>
											setForm((prev) => ({
												...prev,
												deliver: checked === true,
											}))
										}
									/>
									<label htmlFor="cron-deliver" className="cursor-pointer">
										Deliver
									</label>
								</div>
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-channel" className="block">
										Channel
									</label>
									<Select
										value={form.channel}
										onValueChange={(value) =>
											setForm((prev) => ({
												...prev,
												channel: value as CronFormState["channel"],
											}))
										}
									>
										<SelectTrigger id="cron-channel">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="last">Last</SelectItem>
											<SelectItem value="whatsapp">WhatsApp</SelectItem>
											<SelectItem value="telegram">Telegram</SelectItem>
											<SelectItem value="discord">Discord</SelectItem>
											<SelectItem value="slack">Slack</SelectItem>
											<SelectItem value="signal">Signal</SelectItem>
											<SelectItem value="imessage">iMessage</SelectItem>
											<SelectItem value="msteams">MS Teams</SelectItem>
											</SelectContent>
										</Select>
									</div>
								<div className="space-y-1 text-xs text-[#666666]">
									<label htmlFor="cron-timeout" className="block">
										Timeout (seconds)
									</label>
									<Input
										id="cron-timeout"
										value={form.timeoutSeconds}
										onChange={(event) =>
											setForm((prev) => ({
												...prev,
												timeoutSeconds: event.target.value,
											}))
										}
									/>
								</div>
								{form.sessionTarget === "isolated" ? (
									<>
										<div className="space-y-1 text-xs text-[#666666]">
											<label htmlFor="cron-post-main" className="block">
												Post to main prefix
											</label>
											<Input
												id="cron-post-main"
												value={form.postToMainPrefix}
												onChange={(event) =>
													setForm((prev) => ({
														...prev,
														postToMainPrefix: event.target.value,
													}))
												}
											/>
										</div>
										<div className="space-y-1 text-xs text-[#666666]">
											<label htmlFor="cron-post-main-mode" className="block">
												Post to main mode
											</label>
											<Select
												value={form.postToMainMode}
												onValueChange={(value) =>
													setForm((prev) => ({
														...prev,
														postToMainMode:
															value as CronFormState["postToMainMode"],
													}))
												}
											>
												<SelectTrigger id="cron-post-main-mode">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="summary">Summary</SelectItem>
													<SelectItem value="full">Full</SelectItem>
												</SelectContent>
											</Select>
										</div>
										<div className="space-y-1 text-xs text-[#666666]">
											<label htmlFor="cron-post-main-max" className="block">
												Post to main max chars
											</label>
											<Input
												id="cron-post-main-max"
												value={form.postToMainMaxChars}
												onChange={(event) =>
													setForm((prev) => ({
														...prev,
														postToMainMaxChars: event.target.value,
													}))
												}
											/>
										</div>
									</>
								) : null}
							</div>
						) : null}

						<div className="flex items-center gap-2">
							<Button onClick={addJob} disabled={busy}>
								{busy ? "Saving…" : "Add job"}
							</Button>
						</div>
					</CardContent>
				</Card>
			</section>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Jobs</CardTitle>
					<CardDescription>
						All scheduled jobs stored in the gateway.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{jobs.length === 0 ? (
						<div className="text-sm text-[#666666]">No jobs yet.</div>
					) : (
						<div className="space-y-3">
							{jobs.map((job) => (
								<div
									key={job.id}
									role="button"
									tabIndex={0}
									onClick={() => loadRuns(job.id)}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											void loadRuns(job.id);
										}
									}}
									className={`w-full text-left border border-border/60 rounded-md p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
										runsJobId === job.id ? "bg-muted/30" : ""
									}`}
								>
									<div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
										<div className="space-y-1">
											<div className="text-sm font-medium">{job.name}</div>
											<div className="text-xs text-[#666666]">
												{formatCronSchedule(job)}
											</div>
											<div className="text-xs text-[#666666]">
												{formatCronPayload(job)}
											</div>
											{job.agentId ? (
												<div className="text-xs text-[#666666]">
													Agent: {job.agentId}
												</div>
											) : null}
											<div className="flex flex-wrap gap-2 pt-1">
												<Badge>{job.enabled ? "enabled" : "disabled"}</Badge>
												<Badge>{job.sessionTarget}</Badge>
												<Badge>{job.wakeMode}</Badge>
											</div>
										</div>
										<div className="space-y-2 text-right">
											<div className="text-xs text-[#666666]">
												{formatCronState(job)}
											</div>
											<div className="flex flex-wrap justify-end gap-2">
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														void toggleJob(job, !job.enabled);
													}}
												>
													{job.enabled ? "Disable" : "Enable"}
												</Button>
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														void runJob(job);
													}}
												>
													Run
												</Button>
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														void loadRuns(job.id);
													}}
												>
													Runs
												</Button>
												<Button
													variant="destructive"
													size="sm"
													disabled={busy}
													onClick={(event) => {
														event.preventDefault();
														event.stopPropagation();
														void removeJob(job);
													}}
												>
													Remove
												</Button>
											</div>
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Run history</CardTitle>
					<CardDescription>
						Latest runs for {selectedRunsLabel}.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{runsJobId == null ? (
						<div className="text-sm text-[#666666]">
							Select a job to inspect run history.
						</div>
					) : runs.length === 0 ? (
						<div className="text-sm text-[#666666]">No runs yet.</div>
					) : (
						<div className="space-y-2">
							{runs.map((entry) => (
								<div
									key={`${entry.jobId}-${entry.ts}`}
									className="border border-border/60 rounded-md p-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between"
								>
									<div>
										<div className="text-sm font-medium">{entry.status}</div>
										<div className="text-xs text-[#666666]">
											{entry.summary ?? ""}
										</div>
									</div>
									<div className="text-xs text-[#666666] md:text-right">
										<div>{formatMs(entry.ts)}</div>
										<div>{formatDurationMs(entry.durationMs ?? 0)}</div>
										{entry.error ? <div>{entry.error}</div> : null}
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
