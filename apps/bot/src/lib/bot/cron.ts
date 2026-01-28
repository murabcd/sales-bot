import { regex } from "arkregex";

const TIME_RE = regex("^([01]?\\d|2[0-3]):([0-5]\\d)$");

export function formatCronSchedule(schedule: unknown) {
	if (!schedule || typeof schedule !== "object") return "unknown";
	const kind = (schedule as { kind?: string }).kind ?? "unknown";
	if (kind === "interval") {
		const value = (schedule as { value?: number }).value ?? "?";
		const unit = (schedule as { unit?: string }).unit ?? "interval";
		return `every ${value} ${unit}`;
	}
	if (kind === "every") {
		const everyMs = (schedule as { everyMs?: number }).everyMs ?? 0;
		const minutes = Math.max(1, Math.round(everyMs / 60000));
		return `every ${minutes} min`;
	}
	if (kind === "cron") {
		const expr = (schedule as { expr?: string }).expr ?? "cron";
		const tz = (schedule as { tz?: string }).tz;
		return tz ? `${expr} (${tz})` : expr;
	}
	if (kind === "none") return "manual";
	return kind;
}

export function parseTime(value: string) {
	const match = TIME_RE.exec(value.trim());
	if (!match) return null;
	const hour = Number.parseInt(match[1] ?? "0", 10);
	const minute = Number.parseInt(match[2] ?? "0", 10);
	return { hour, minute };
}

export function buildCronExpr(
	time: { hour: number; minute: number },
	weekdays: boolean,
) {
	const dow = weekdays ? "1-5" : "*";
	return `${time.minute} ${time.hour} * * ${dow}`;
}

export function formatCronJob(job: unknown) {
	if (!job || typeof job !== "object") return "unknown job";
	const record = job as {
		id?: string;
		name?: string;
		enabled?: boolean;
		schedule?: unknown;
		payload?: { kind?: string };
		state?: {
			nextRunAtMs?: number;
			lastRunAtMs?: number;
			lastStatus?: string;
		};
	};
	const enabled = record.enabled === false ? "off" : "on";
	const schedule = formatCronSchedule(record.schedule);
	const payload = record.payload?.kind ?? "unknown";
	const nextRun =
		typeof record.state?.nextRunAtMs === "number"
			? new Date(record.state.nextRunAtMs).toISOString()
			: "n/a";
	const lastRun =
		typeof record.state?.lastRunAtMs === "number"
			? new Date(record.state.lastRunAtMs).toISOString()
			: "n/a";
	const lastStatus = record.state?.lastStatus ?? "n/a";
	return `${record.id ?? "unknown"} | ${enabled} | ${record.name ?? "Untitled"} | ${schedule} | ${payload} | next ${nextRun} | last ${lastStatus} ${lastRun}`;
}

export function findCronJob(jobs: unknown[], target: string) {
	const needle = target.trim().toLowerCase();
	const matches = jobs.filter((job) => {
		if (!job || typeof job !== "object") return false;
		const record = job as { id?: string; name?: string };
		const id = record.id?.toLowerCase() ?? "";
		const name = record.name?.toLowerCase() ?? "";
		return id === needle || id.startsWith(needle) || name === needle;
	});
	return matches;
}
