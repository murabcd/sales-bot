import type {
	DurableObject,
	DurableObjectState,
	Request as WorkerRequest,
	Response as WorkerResponse,
} from "@cloudflare/workers-types";
import { Cron } from "croner";
import modelsConfig from "../apps/bot/config/models.json";
import runtimeSkills from "../apps/bot/config/runtime-skills.json";
import { createBot } from "../apps/bot/src/bot.js";
import { markdownToTelegramHtmlChunks } from "../apps/bot/src/lib/telegram/format.js";

export type CronSchedule =
	| { kind: "at"; atMs: number }
	| { kind: "every"; everyMs: number; anchorMs?: number }
	| { kind: "cron"; expr: string; tz?: string };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
	| { kind: "systemEvent"; text: string }
	| {
			kind: "agentTurn";
			message: string;
			model?: string;
			thinking?: string;
			timeoutSeconds?: number;
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
			provider?:
				| "last"
				| "whatsapp"
				| "telegram"
				| "discord"
				| "slack"
				| "signal"
				| "imessage"
				| "msteams";
			to?: string;
			bestEffortDeliver?: boolean;
	  };

export type CronIsolation = {
	postToMainPrefix?: string;
	postToMainMode?: "summary" | "full";
	postToMainMaxChars?: number;
};

export type CronJobState = {
	nextRunAtMs?: number;
	runningAtMs?: number;
	lastRunAtMs?: number;
	lastStatus?: "ok" | "error" | "skipped";
	lastError?: string;
	lastDurationMs?: number;
};

export type CronJob = {
	id: string;
	agentId?: string;
	name: string;
	description?: string;
	enabled: boolean;
	deleteAfterRun?: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	schedule: CronSchedule;
	sessionTarget: CronSessionTarget;
	wakeMode: CronWakeMode;
	payload: CronPayload;
	isolation?: CronIsolation;
	state?: CronJobState;
};

export type CronStatus = {
	enabled: boolean;
	jobs: number;
	nextWakeAtMs?: number | null;
};

export type CronRunLogEntry = {
	ts: number;
	jobId: string;
	status: "ok" | "error" | "skipped";
	durationMs?: number;
	error?: string;
	summary?: string;
};

const STORE_KEY = "cron";
const MAX_RUN_LOGS = 200;
let botPromise: Promise<Awaited<ReturnType<typeof createBot>>> | null = null;

function now() {
	return Date.now();
}

function toWorkerResponse(response: Response): WorkerResponse {
	return response as unknown as WorkerResponse;
}

async function getBot(env: Record<string, string | undefined>) {
	if (botPromise === null) {
		botPromise = (async () => {
			const runtime = await createBot({
				env,
				modelsConfig,
				runtimeSkills,
			});
			await runtime.bot.init();
			return runtime;
		})();
	}
	return botPromise;
}

async function sendTelegramMessage(
	token: string,
	chatId: string,
	text: string,
) {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const chunks = markdownToTelegramHtmlChunks(text, 4000);
	for (const chunk of chunks) {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text: chunk,
				parse_mode: "HTML",
				disable_web_page_preview: true,
			}),
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`telegram_send_failed:${response.status}:${response.statusText}:${body}`,
			);
		}
	}
}

type StoredCron = {
	jobs: Record<string, CronJob>;
	runs: Record<string, CronRunLogEntry[]>;
};

function normalizeSchedule(raw: CronSchedule): CronSchedule {
	if (raw.kind === "at") {
		return { kind: "at", atMs: raw.atMs };
	}
	if (raw.kind === "every") {
		return {
			kind: "every",
			everyMs: raw.everyMs,
			anchorMs: raw.anchorMs,
		};
	}
	return {
		kind: "cron",
		expr: raw.expr,
		tz: raw.tz,
	};
}

function normalizePayload(raw: CronPayload): CronPayload {
	if (raw.kind === "systemEvent") {
		return { kind: "systemEvent", text: raw.text };
	}
	return {
		kind: "agentTurn",
		message: raw.message,
		model: raw.model,
		thinking: raw.thinking,
		timeoutSeconds: raw.timeoutSeconds,
		deliver: raw.deliver,
		channel: raw.channel,
		provider: raw.provider,
		to: raw.to,
		bestEffortDeliver: raw.bestEffortDeliver,
	};
}

function normalizeJob(raw: CronJob): CronJob {
	const createdAtMs = Number.isFinite(raw.createdAtMs)
		? raw.createdAtMs
		: now();
	return {
		id: raw.id || crypto.randomUUID(),
		agentId: raw.agentId?.trim() || undefined,
		name: raw.name?.trim() || "Untitled",
		description: raw.description?.trim() || undefined,
		enabled: raw.enabled ?? true,
		deleteAfterRun: raw.deleteAfterRun ?? false,
		createdAtMs,
		updatedAtMs: now(),
		schedule: normalizeSchedule(raw.schedule),
		sessionTarget: raw.sessionTarget === "isolated" ? "isolated" : "main",
		wakeMode: raw.wakeMode === "now" ? "now" : "next-heartbeat",
		payload: normalizePayload(raw.payload),
		isolation:
			raw.isolation && typeof raw.isolation === "object"
				? {
						postToMainPrefix:
							raw.isolation.postToMainPrefix?.trim() || undefined,
						postToMainMode:
							raw.isolation.postToMainMode === "full" ? "full" : "summary",
						postToMainMaxChars:
							typeof raw.isolation.postToMainMaxChars === "number" &&
							Number.isFinite(raw.isolation.postToMainMaxChars)
								? Math.max(1, Math.floor(raw.isolation.postToMainMaxChars))
								: undefined,
					}
				: undefined,
		state: raw.state ?? {},
	};
}

function computeEveryNextRun(job: CronJob, timestamp: number) {
	const schedule = job.schedule;
	if (schedule.kind !== "every") return null;
	const interval = Math.max(1, schedule.everyMs);
	const anchor = Number.isFinite(schedule.anchorMs)
		? (schedule.anchorMs ?? job.createdAtMs)
		: job.createdAtMs;
	if (timestamp <= anchor) return anchor;
	const elapsed = timestamp - anchor;
	const steps = Math.floor(elapsed / interval) + 1;
	return anchor + steps * interval;
}

function parseCronExpression(expr: string) {
	return expr.trim();
}

function findNextCronRun(
	expr: string,
	fromMs: number,
	tz?: string,
): number | null {
	const parsed = parseCronExpression(expr);
	if (!parsed) return null;
	try {
		const cron = new Cron(parsed, {
			timezone: tz?.trim() || undefined,
			catch: false,
		});
		const next = cron.nextRun(new Date(fromMs));
		return next ? next.getTime() : null;
	} catch {
		return null;
	}
}

function computeNextRun(job: CronJob, timestamp: number) {
	if (!job.enabled) return null;
	if (job.schedule.kind === "at") {
		const at = job.schedule.atMs;
		const lastRun = job.state?.lastRunAtMs ?? 0;
		if (Number.isFinite(lastRun) && lastRun >= at) return null;
		return at;
	}
	if (job.schedule.kind === "every") {
		return computeEveryNextRun(job, timestamp);
	}
	const expr = job.schedule.expr.trim();
	if (!expr) return null;
	return findNextCronRun(expr, timestamp, job.schedule.tz);
}

function formatAgentSummary(messages: string[]) {
	if (messages.length === 0) return "(no reply)";
	if (messages.length === 1) return messages[0];
	return `${messages[0]} (+${messages.length - 1} more)`;
}

export class CronDO implements DurableObject {
	private state: DurableObjectState;
	private env: Record<string, string | undefined>;

	constructor(
		state: DurableObjectState,
		env: Record<string, string | undefined>,
	) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: WorkerRequest): Promise<WorkerResponse> {
		const url = new URL(request.url);
		if (request.method !== "POST") {
			return toWorkerResponse(new Response("Method Not Allowed", { status: 405 }));
		}
		const body = await request.json();
		switch (url.pathname) {
			case "/status":
				return this.status();
			case "/list":
				return this.list(body as Record<string, unknown>);
			case "/add":
				return this.add(body as Record<string, unknown>);
			case "/update":
				return this.update(body as Record<string, unknown>);
			case "/remove":
				return this.remove(body as Record<string, unknown>);
			case "/run":
				return this.run(body as Record<string, unknown>);
			case "/runs":
				return this.runs(body as Record<string, unknown>);
			case "/wake":
				return this.wake(body as Record<string, unknown>);
			case "/tick":
				return this.tick();
			default:
				return toWorkerResponse(new Response("Not Found", { status: 404 }));
		}
	}

	async alarm(): Promise<void> {
		await this.processDueJobs();
	}

	private async load(): Promise<StoredCron> {
		const stored = (await this.state.storage.get<StoredCron>(STORE_KEY)) ?? {
			jobs: {},
			runs: {},
		};
		return {
			jobs: stored.jobs ?? {},
			runs: stored.runs ?? {},
		};
	}

	private async save(next: StoredCron) {
		await this.state.storage.put(STORE_KEY, next);
	}

	private computeNextWake(jobs: Record<string, CronJob>) {
		const timestamp = now();
		let next: number | null = null;
		for (const job of Object.values(jobs)) {
			const candidate = computeNextRun(job, timestamp);
			if (candidate == null) continue;
			const finalCandidate = candidate < timestamp ? timestamp : candidate;
			job.state = { ...(job.state ?? {}), nextRunAtMs: candidate };
			if (next == null || finalCandidate < next) next = finalCandidate;
		}
		return next;
	}

	private async scheduleNextWake(jobs: Record<string, CronJob>) {
		const next = this.computeNextWake(jobs);
		if (next != null) {
			await this.state.storage.setAlarm(next);
		}
		return next;
	}

	private async status(): Promise<WorkerResponse> {
		const state = await this.load();
		const nextWakeAtMs = this.computeNextWake(state.jobs);
		const status: CronStatus = {
			enabled: true,
			jobs: Object.keys(state.jobs).length,
			nextWakeAtMs,
		};
		return toWorkerResponse(Response.json(status));
	}

	private async list(params: Record<string, unknown>): Promise<WorkerResponse> {
		const includeDisabled = params.includeDisabled !== false;
		const state = await this.load();
		const jobs = Object.values(state.jobs).filter((job) =>
			includeDisabled ? true : job.enabled,
		);
		return toWorkerResponse(Response.json({ jobs }));
	}

	private async add(params: Record<string, unknown>): Promise<WorkerResponse> {
		const raw = params as CronJob;
		const state = await this.load();
		const job = normalizeJob(raw);
		if (
			(job.sessionTarget === "main" && job.payload.kind !== "systemEvent") ||
			(job.sessionTarget === "isolated" && job.payload.kind !== "agentTurn")
		) {
			return toWorkerResponse(new Response("invalid_job_payload", { status: 400 }));
		}
		job.state = job.state ?? {};
		job.state.nextRunAtMs = computeNextRun(job, now()) ?? undefined;
		state.jobs[job.id] = job;
		await this.scheduleNextWake(state.jobs);
		await this.save(state);
		return toWorkerResponse(Response.json(job));
	}

	private async update(params: Record<string, unknown>): Promise<WorkerResponse> {
		const jobId =
			typeof params.id === "string"
				? params.id
				: typeof params.jobId === "string"
					? params.jobId
					: "";
		if (!jobId) return toWorkerResponse(new Response("missing_id", { status: 400 }));
		const patch = (params.patch ?? {}) as Partial<CronJob>;
		const state = await this.load();
		const existing = state.jobs[jobId];
		if (!existing) return toWorkerResponse(new Response("not_found", { status: 404 }));
		const next: CronJob = {
			...existing,
			...patch,
			schedule: patch.schedule
				? normalizeSchedule(patch.schedule as CronSchedule)
				: existing.schedule,
			payload: patch.payload
				? normalizePayload(patch.payload as CronPayload)
				: existing.payload,
			updatedAtMs: now(),
		};
		if (patch.agentId !== undefined) {
			next.agentId = patch.agentId?.trim() || undefined;
		}
		if (patch.name !== undefined) {
			next.name = patch.name?.trim() || "Untitled";
		}
		if (patch.description !== undefined) {
			next.description = patch.description?.trim() || undefined;
		}
		if (patch.isolation !== undefined) {
			next.isolation = patch.isolation?.postToMainPrefix?.trim()
				? {
						postToMainPrefix: patch.isolation.postToMainPrefix.trim(),
						postToMainMode:
							patch.isolation.postToMainMode === "full" ? "full" : "summary",
						postToMainMaxChars:
							typeof patch.isolation.postToMainMaxChars === "number" &&
							Number.isFinite(patch.isolation.postToMainMaxChars)
								? Math.max(1, Math.floor(patch.isolation.postToMainMaxChars))
								: undefined,
					}
				: undefined;
		}
		next.state = { ...(existing.state ?? {}), ...(patch.state ?? {}) };
		if (
			(next.sessionTarget === "main" && next.payload.kind !== "systemEvent") ||
			(next.sessionTarget === "isolated" && next.payload.kind !== "agentTurn")
		) {
			return toWorkerResponse(new Response("invalid_job_payload", { status: 400 }));
		}
		next.state.nextRunAtMs = computeNextRun(next, now()) ?? undefined;
		state.jobs[jobId] = next;
		await this.scheduleNextWake(state.jobs);
		await this.save(state);
		return toWorkerResponse(Response.json(next));
	}

	private async remove(params: Record<string, unknown>): Promise<WorkerResponse> {
		const jobId =
			typeof params.id === "string"
				? params.id
				: typeof params.jobId === "string"
					? params.jobId
					: "";
		if (!jobId) return toWorkerResponse(new Response("missing_id", { status: 400 }));
		const state = await this.load();
		delete state.jobs[jobId];
		delete state.runs[jobId];
		await this.scheduleNextWake(state.jobs);
		await this.save(state);
		return toWorkerResponse(Response.json({ ok: true, removed: true }));
	}

	private async runs(params: Record<string, unknown>): Promise<WorkerResponse> {
		const jobId =
			typeof params.id === "string"
				? params.id
				: typeof params.jobId === "string"
					? params.jobId
					: "";
		if (!jobId) return toWorkerResponse(new Response("missing_id", { status: 400 }));
		const limit = Number.parseInt(String(params.limit ?? ""), 10);
		const state = await this.load();
		const entries = state.runs[jobId] ?? [];
		const sliced =
			Number.isFinite(limit) && limit > 0 ? entries.slice(0, limit) : entries;
		return toWorkerResponse(Response.json({ entries: sliced }));
	}

	private async wake(params: Record<string, unknown>): Promise<WorkerResponse> {
		const text = typeof params.text === "string" ? params.text.trim() : "";
		if (!text) return toWorkerResponse(new Response("text required", { status: 400 }));
		try {
			const runtime = await getBot(this.env);
			const result = await runtime.runLocalChat({
				text,
				chatId: "main",
				userId: "cron",
				userName: "Cron",
				chatType: "private",
			});
			return toWorkerResponse(
				Response.json({ ok: true, messages: result.messages ?? [] }),
			);
		} catch (err) {
			return toWorkerResponse(new Response(String(err), { status: 500 }));
		}
	}

	private async run(params: Record<string, unknown>): Promise<WorkerResponse> {
		const jobId =
			typeof params.id === "string"
				? params.id
				: typeof params.jobId === "string"
					? params.jobId
					: "";
		if (!jobId) return toWorkerResponse(new Response("missing_id", { status: 400 }));
		const mode = params.mode === "force" ? "force" : "due";
		await this.processDueJobs({ onlyJobId: jobId, mode });
		return toWorkerResponse(Response.json({ ok: true }));
	}

	private async tick(): Promise<WorkerResponse> {
		await this.processDueJobs();
		return toWorkerResponse(Response.json({ ok: true }));
	}

	private async appendRun(state: StoredCron, entry: CronRunLogEntry) {
		const list = state.runs[entry.jobId] ?? [];
		list.unshift(entry);
		if (list.length > MAX_RUN_LOGS) list.length = MAX_RUN_LOGS;
		state.runs[entry.jobId] = list;
	}

	private async processDueJobs(options?: {
		onlyJobId?: string;
		mode?: "due" | "force";
	}) {
		const state = await this.load();
		const timestamp = now();
		const runJobs = Object.values(state.jobs).filter((job) => {
			if (options?.onlyJobId && job.id !== options.onlyJobId) return false;
			if (!job.enabled && options?.mode !== "force") return false;
			const nextRunAtMs = computeNextRun(job, timestamp);
			job.state = {
				...(job.state ?? {}),
				nextRunAtMs: nextRunAtMs ?? undefined,
			};
			if (options?.mode === "force") return true;
			if (nextRunAtMs == null) return false;
			return nextRunAtMs <= timestamp;
		});
		for (const job of runJobs) {
			const startedAt = now();
			if (job.state?.runningAtMs) {
				await this.appendRun(state, {
					ts: startedAt,
					jobId: job.id,
					status: "skipped",
					summary: "already running",
				});
				continue;
			}
			job.state = { ...(job.state ?? {}), runningAtMs: startedAt };
			let status: CronRunLogEntry["status"] = "ok";
			let summary: string | undefined;
			let error: string | undefined;
			try {
				if (job.payload.kind === "systemEvent") {
					summary = job.payload.text;
				} else {
					const runtime = await getBot(this.env);
					const result = await runtime.runLocalChat({
						text: job.payload.message,
						chatId: job.payload.to ?? `cron:${job.id}`,
						userId: "cron",
						userName: "Cron",
						chatType: "private",
					});
					summary = formatAgentSummary(result.messages ?? []);
					const channel =
						job.payload.channel ??
						job.payload.provider ??
						(job.payload.deliver ? "last" : undefined);
					if (
						job.payload.deliver &&
						this.env.BOT_TOKEN &&
						job.payload.to &&
						(channel === "telegram" || channel === "last")
					) {
						for (const message of result.messages ?? []) {
							await sendTelegramMessage(
								this.env.BOT_TOKEN as string,
								job.payload.to,
								message,
							);
						}
					}
					if (
						job.sessionTarget === "isolated" &&
						job.isolation?.postToMainPrefix
					) {
						let outputText = "";
						const messages = result.messages ?? [];
						for (let i = messages.length - 1; i >= 0; i -= 1) {
							const candidate = messages[i]?.trim() ?? "";
							if (candidate) {
								outputText = candidate;
								break;
							}
						}
						let postText =
							job.isolation.postToMainMode === "full"
								? outputText
								: (summary ?? outputText);
						if (!postText.trim()) postText = "(no reply)";
						const prefix = job.isolation.postToMainPrefix.trim();
						const maxChars = job.isolation.postToMainMaxChars ?? 8000;
						const combined = `${prefix}${prefix.endsWith(" ") ? "" : " "}${postText}`;
						const truncated =
							combined.length > maxChars
								? combined.slice(0, maxChars)
								: combined;
						await runtime.runLocalChat({
							text: truncated,
							chatId: "main",
							userId: "cron",
							userName: "Cron",
							chatType: "private",
						});
					}
				}
			} catch (err) {
				status = "error";
				error = err instanceof Error ? err.message : String(err);
			}
			const finishedAt = now();
			job.state = {
				...(job.state ?? {}),
				runningAtMs: undefined,
				lastRunAtMs: finishedAt,
				lastStatus: status,
				lastError: error,
				lastDurationMs: finishedAt - startedAt,
			};
			job.updatedAtMs = finishedAt;
			await this.appendRun(state, {
				ts: finishedAt,
				jobId: job.id,
				status,
				error,
				summary,
				durationMs: finishedAt - startedAt,
			});
			if (job.deleteAfterRun) {
				delete state.jobs[job.id];
				delete state.runs[job.id];
				continue;
			}
			if (job.schedule.kind === "at") {
				job.enabled = false;
			}
			job.state.nextRunAtMs = computeNextRun(job, now()) ?? undefined;
			state.jobs[job.id] = job;
		}
		await this.scheduleNextWake(state.jobs);
		await this.save(state);
	}
}
