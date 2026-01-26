import { formatAgo, formatDurationMs, formatMs } from "@/lib/format";
import type { CronJob } from "@/lib/cron-types";
import type { GatewaySessionRow } from "@/lib/sessions-types";

export function formatNextRun(ms?: number | null) {
	if (!ms) return "n/a";
	return `${formatMs(ms)} (${formatAgo(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
	if (row.totalTokens == null) return "n/a";
	const total = row.totalTokens ?? 0;
	const ctx = row.contextTokens ?? 0;
	return ctx ? `${total} / ${ctx}` : String(total);
}

export function formatCronState(job: CronJob) {
	const state = job.state ?? {};
	const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : "n/a";
	const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : "n/a";
	const status = state.lastStatus ?? "n/a";
	return `${status} · next ${next} · last ${last}`;
}

export function formatCronSchedule(job: CronJob) {
	const s = job.schedule;
	if (s.kind === "at") return `At ${formatMs(s.atMs)}`;
	if (s.kind === "every") return `Every ${formatDurationMs(s.everyMs)}`;
	return `Cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}

export function formatCronPayload(job: CronJob) {
	const p = job.payload;
	if (p.kind === "systemEvent") return `System: ${p.text}`;
	if (p.kind === "dailyStatus") {
		return `Daily status${p.to ? ` → ${p.to}` : ""}`;
	}
	return `Agent: ${p.message}`;
}
