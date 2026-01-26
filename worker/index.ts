import type {
	DurableObject,
	DurableObjectNamespace,
	DurableObjectState,
	ExecutionContext,
	ScheduledEvent,
	Request as WorkerRequest,
	Response as WorkerResponse,
} from "@cloudflare/workers-types";
import type { Update } from "grammy/types";
import modelsConfig from "../apps/bot/config/models.json";
import runtimeSkills from "../apps/bot/config/runtime-skills.json";
import { createBot } from "../apps/bot/src/bot.js";
import { authorizeAdminRequest } from "../apps/bot/src/lib/gateway/admin-auth.js";
import {
	type GatewayConfig,
	applyGatewayConfig,
	buildGatewayConfigSnapshot,
	sanitizeGatewayConfig,
} from "../apps/bot/src/lib/gateway/config.js";
import {
	authorizeGatewayToken,
	buildAdminStatusPayload,
	parseList,
} from "./lib/gateway.js";
import {
	SKILLS_CONFIG_KEY,
	buildSkillsStatusReport,
	parseSkillsConfig,
	serializeSkillsConfig,
} from "./lib/skills.js";
import { allowTelegramUpdate } from "../apps/bot/src/lib/gateway/telegram-allowlist.js";
import { buildDailyStatusReportParts } from "../apps/bot/src/lib/reports/daily-status.js";
import { markdownToTelegramHtmlChunks } from "../apps/bot/src/lib/telegram/format.js";
import { CronDO } from "./cron-do.js";
import { ChannelsDO } from "./channels-do.js";
import { SessionsDO } from "./sessions-do.js";

const startTime = Date.now();

type Env = Record<string, string | undefined> & {
	UPDATES_DO: DurableObjectNamespace;
	GATEWAY_CONFIG_DO: DurableObjectNamespace;
	SESSIONS_DO: DurableObjectNamespace;
	CRON_DO: DurableObjectNamespace;
	CHANNELS_DO: DurableObjectNamespace;
};

type BotRuntime = Awaited<ReturnType<typeof createBot>>;

let botPromise: Promise<BotRuntime> | null = null;
const streamAbortControllers = new Map<string, AbortController>();
let activeGatewayConnections = 0;

export function registerStreamAbort(
	registry: Map<string, AbortController>,
	streamId: string,
) {
	const controller = new AbortController();
	registry.set(streamId, controller);
	return controller;
}

export function abortStream(
	registry: Map<string, AbortController>,
	streamId: string,
) {
	const controller = registry.get(streamId);
	if (!controller) return false;
	controller.abort();
	registry.delete(streamId);
	return true;
}

function getUptimeSeconds() {
	return (Date.now() - startTime) / 1000;
}

async function getBot(env: Record<string, string | undefined>) {
	if (!botPromise) {
		botPromise = (async () => {
			const runtime = await createBot({
				env,
				modelsConfig,
				runtimeSkills,
				getUptimeSeconds,
			});
			await runtime.bot.init();
			return runtime;
		})();
	}
	return botPromise;
}

function getSessionsStub(env: Env) {
	const id = env.SESSIONS_DO.idFromName("sessions");
	return env.SESSIONS_DO.get(id);
}

function getCronStub(env: Env) {
	const id = env.CRON_DO.idFromName("cron");
	return env.CRON_DO.get(id);
}

function getChannelsStub(env: Env) {
	const id = env.CHANNELS_DO.idFromName("channels");
	return env.CHANNELS_DO.get(id);
}

async function callSessions(
	env: Env,
	path: string,
	params: Record<string, unknown>,
) {
	const stub = getSessionsStub(env);
	return withTimeout(
		stub.fetch(`https://do${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}),
		5_000,
	);
}

async function callCron(env: Env, path: string, params: Record<string, unknown>) {
	const stub = getCronStub(env);
	return withTimeout(
		stub.fetch(`https://do${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}),
		5_000,
	);
}

async function callChannels(
	env: Env,
	path: string,
	params: Record<string, unknown>,
) {
	const stub = getChannelsStub(env);
	return withTimeout(
		stub.fetch(`https://do${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}),
		5_000,
	);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error("timeout"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function mapTelegramKind(kind?: string) {
	if (kind === "private") return "direct";
	if (kind === "group" || kind === "supergroup") return "group";
	if (kind === "channel") return "group";
	return "unknown";
}

function resolveTelegramSession(update: Update) {
	const payload = (update as Update & Record<string, unknown>) ?? {};
	const message =
		(payload.message as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.edited_message as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.channel_post as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.edited_channel_post as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.callback_query as { message?: { chat?: { id?: number; type?: string; title?: string } } } | undefined)?.message ??
		undefined;
	const chat = message?.chat;
	if (!chat?.id) return null;
	const chatId = String(chat.id);
	const kind = mapTelegramKind(chat.type);
	const title = typeof chat.title === "string" ? chat.title.trim() : "";
	return {
		key: `telegram:${chatId}`,
		kind,
		surface: "telegram",
		displayName: title || chatId,
		label: title || undefined,
	};
}

function resolveTelegramChannel(update: Update) {
	const payload = (update as Update & Record<string, unknown>) ?? {};
	const message =
		(payload.message as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.edited_message as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.channel_post as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.edited_channel_post as { chat?: { id?: number; type?: string; title?: string } } | undefined) ??
		(payload.callback_query as { message?: { chat?: { id?: number; type?: string; title?: string } } } | undefined)?.message ??
		undefined;
	const chat = message?.chat;
	if (!chat?.id) return null;
	const chatId = String(chat.id);
	const kind = mapTelegramKind(chat.type);
	const title = typeof chat.title === "string" ? chat.title.trim() : "";
	return {
		key: `telegram:${chatId}`,
		chatId,
		kind,
		surface: "telegram",
		title: title || undefined,
		label: title || undefined,
	};
}

async function touchTelegramSession(env: Env, update: Update) {
	const session = resolveTelegramSession(update);
	if (!session) return;
	await callSessions(env, "/touch", session);
}

async function touchTelegramChannel(env: Env, update: Update) {
	const channel = resolveTelegramChannel(update);
	if (!channel) return { enabled: true };
	const response = await callChannels(env, "/touch", channel);
	if (!response.ok) return { enabled: true };
	const payload = (await response.json()) as {
		entry?: {
			enabled?: boolean;
			requireMention?: boolean;
			allowUserIds?: string[];
			skillsAllowlist?: string[];
			skillsDenylist?: string[];
			systemPrompt?: string;
		};
	};
	return {
		enabled: payload?.entry?.enabled !== false,
		config: payload?.entry,
	};
}

async function touchAdminSession(params: {
	env: Env;
	chatId: string;
	chatType?: "private" | "group" | "supergroup" | "channel";
	userName?: string;
}) {
	const kind =
		params.chatType === "group" ||
		params.chatType === "supergroup" ||
		params.chatType === "channel"
			? "group"
			: "direct";
	await callSessions(params.env, "/touch", {
		key: `admin:${params.chatId}`,
		kind,
		surface: "admin",
		displayName: params.userName?.trim() || params.chatId,
		label: params.userName?.trim() || undefined,
	});
}


function extractClientIp(request: WorkerRequest) {
	return (
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		""
	);
}

async function readGatewayConfig(env: Env): Promise<GatewayConfig> {
	const id = env.GATEWAY_CONFIG_DO.idFromName("gateway-config");
	const stub = env.GATEWAY_CONFIG_DO.get(id);
	try {
		const response = await withTimeout(stub.fetch("https://do/config"), 5_000);
		if (!response.ok) return {};
		const payload = (await response.json()) as { config?: GatewayConfig };
		return payload.config ?? {};
	} catch (error) {
		console.error("gateway_config_read_error", error);
		return {};
	}
}

async function writeGatewayConfig(env: Env, config: GatewayConfig) {
	const id = env.GATEWAY_CONFIG_DO.idFromName("gateway-config");
	const stub = env.GATEWAY_CONFIG_DO.get(id);
	const response = await withTimeout(
		stub.fetch("https://do/config", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config }),
		}),
		5_000,
	);
	if (!response.ok) {
		throw new Error(`gateway_config_write_failed:${response.status}`);
	}
	const payload = (await response.json()) as { config?: GatewayConfig };
	return payload.config ?? {};
}

export default {
	async fetch(
		request: WorkerRequest,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<WorkerResponse> {
		const url = new URL(request.url);
		const startMs = Date.now();
		if (url.pathname === "/gateway" && isWebSocketUpgrade(request)) {
			return handleGatewayWebSocket(request, env);
		}
		const route = url.pathname.startsWith("/admin")
			? "admin"
			: url.pathname === "/telegram"
				? "telegram"
				: "other";
		const config = await readGatewayConfig(env);
		const effectiveEnv = applyGatewayConfig(env, config);

		if (route === "admin") {
			if (request.method === "OPTIONS") {
				return toWorkerResponse(withCors(new Response(null, { status: 204 })));
			}
			const adminRequest = request as unknown as Request;
			const decision = authorizeAdminRequest(adminRequest, effectiveEnv);
			if (!decision.allowed) {
				return toWorkerResponse(
					withCors(
						new Response("Unauthorized", {
							status: 401,
							headers: { "Content-Type": "text/plain" },
						}),
					),
				);
			}
			try {
				const response = await handleAdminRequest(request, effectiveEnv);
				return toWorkerResponse(response);
			} catch (error) {
				throw error;
			}
		}
		if (url.pathname !== "/telegram") {
			return toWorkerResponse(new Response("Not found", { status: 404 }));
		}
		if (request.method !== "POST") {
			return toWorkerResponse(
				new Response("Method Not Allowed", { status: 405 }),
			);
		}
		const update = await request.json();
		if (!isTelegramUpdate(update)) {
			return toWorkerResponse(new Response("Bad Request", { status: 400 }));
		}
		const updateDecision = allowTelegramUpdate(update, effectiveEnv);
		if (!updateDecision.allowed) {
			console.log(
				JSON.stringify({
					event: "gateway_blocked",
					reason: updateDecision.reason ?? "not_allowed",
				}),
			);
			return toWorkerResponse(new Response("OK", { status: 200 }));
		}
		const telegramRequest = request as unknown as Request;
		const id = env.UPDATES_DO.idFromName("telegram-updates");
		const stub = env.UPDATES_DO.get(id);
		try {
			await stub.fetch("https://do/enqueue", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(update),
			});
			return toWorkerResponse(new Response("OK", { status: 200 }));
		} catch (error) {
			throw error;
		}
	},
	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		const cronTask = (async () => {
			try {
				await callCron(env, "/tick", {});
			} catch (error) {
				console.error("cron_tick_error", error);
			}
		})();
		ctx.waitUntil(cronTask);

		const config = await readGatewayConfig(env);
		const effectiveEnv = applyGatewayConfig(env, config);
		if (effectiveEnv.CRON_STATUS_ENABLED !== "1") return;
		const chatId = effectiveEnv.CRON_STATUS_CHAT_ID?.trim();
		if (!chatId) return;
		if (!effectiveEnv.BOT_TOKEN) return;
		const task = (async () => {
			try {
				const reportParts = await buildDailyStatusReportParts({
					env: effectiveEnv,
				});
				await sendDailyStatusMessages(
					effectiveEnv.BOT_TOKEN as string,
					chatId,
					reportParts,
				);
			} catch (error) {
				console.error("cron_daily_status_error", error);
			}
		})();
		ctx.waitUntil(task);
	},
};

export { SessionsDO, CronDO, ChannelsDO };

export class GatewayConfigDO implements DurableObject {
	private state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: WorkerRequest): Promise<WorkerResponse> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/config") {
			const config =
				(await this.state.storage.get<GatewayConfig>("config")) ?? {};
			return toWorkerResponse(
				new Response(JSON.stringify({ config }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		if (request.method === "POST" && url.pathname === "/config") {
			const body = (await request.json()) as { config?: unknown };
			const config = sanitizeGatewayConfig(body?.config);
			await this.state.storage.put("config", config);
			return toWorkerResponse(
				new Response(JSON.stringify({ config }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		return toWorkerResponse(new Response("Not found", { status: 404 }));
	}
}

type QueueItem = {
	id: string;
	update: Update;
	attempt: number;
	nextAt: number;
};

type StoredState = {
	queue: QueueItem[];
	processedIds: string[];
};

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const PROCESSED_IDS_MAX = 1_000;

export class TelegramUpdatesDO implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private processing = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: WorkerRequest): Promise<WorkerResponse> {
		const url = new URL(request.url);
		if (url.pathname !== "/enqueue") {
			return toWorkerResponse(new Response("Not found", { status: 404 }));
		}
		if (request.method !== "POST") {
			return toWorkerResponse(
				new Response("Method Not Allowed", { status: 405 }),
			);
		}
		const update = await request.json();
		if (!isTelegramUpdate(update)) {
			return toWorkerResponse(new Response("Bad Request", { status: 400 }));
		}
		if (isCallbackUpdate(update)) {
			const handled = await this.tryHandleCallback(update);
			if (handled) {
				logUpdateHandled("callback_fastpath", update);
				return toWorkerResponse(new Response("OK", { status: 200 }));
			}
		}
		await this.enqueueUpdate(update);
		logUpdateHandled("queued", update);
		this.state.waitUntil(this.processQueue());
		return toWorkerResponse(new Response("OK", { status: 200 }));
	}

	async alarm(): Promise<void> {
		await this.processQueue();
	}

	private async loadState(): Promise<StoredState> {
		const stored =
			(await this.state.storage.get<StoredState>("state")) ??
			({ queue: [], processedIds: [] } as StoredState);
		return {
			queue: Array.isArray(stored.queue) ? stored.queue : [],
			processedIds: Array.isArray(stored.processedIds)
				? stored.processedIds
				: [],
		};
	}

	private async saveState(state: StoredState): Promise<void> {
		await this.state.storage.put("state", state);
	}

	private async enqueueUpdate(update: Update) {
		const state = await this.loadState();
		const updateId =
			typeof update.update_id === "number"
				? String(update.update_id)
				: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		if (state.processedIds.includes(updateId)) return;
		if (state.queue.some((item) => item.id === updateId)) return;
		state.queue.push({
			id: updateId,
			update,
			attempt: 0,
			nextAt: Date.now(),
		});
		await this.saveState(state);
	}

	private async tryHandleCallback(update: Update) {
		const updateId =
			typeof update.update_id === "number" ? String(update.update_id) : null;
		const state = await this.loadState();
		if (updateId) {
			if (state.processedIds.includes(updateId)) return true;
			if (state.queue.some((item) => item.id === updateId)) return true;
		}

		try {
			const runtime = await getBot(this.env);
			const channel = await touchTelegramChannel(this.env, update);
			if (!channel.enabled) return true;
			if (channel.config) {
				(update as Update & { __channelConfig?: unknown }).__channelConfig =
					channel.config;
			}
			await runtime.bot.handleUpdate(update);
			await touchTelegramSession(this.env, update);
			if (updateId) {
				state.processedIds.push(updateId);
				if (state.processedIds.length > PROCESSED_IDS_MAX) {
					state.processedIds = state.processedIds.slice(
						-state.processedIds.length + PROCESSED_IDS_MAX,
					);
				}
				await this.saveState(state);
			}
			return true;
		} catch (error) {
			console.error("telegram_update_error", error);
			return false;
		}
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			const runtime = await getBot(this.env);
			const state = await this.loadState();

			while (state.queue.length > 0) {
				state.queue.sort((a, b) => a.nextAt - b.nextAt);
				const item = state.queue[0];
				if (!item) break;
				if (item.nextAt > Date.now()) {
					await this.state.storage.setAlarm(item.nextAt);
					break;
				}

				state.queue.shift();
				try {
					const channel = await touchTelegramChannel(this.env, item.update);
					if (!channel.enabled) {
						state.processedIds.push(item.id);
						if (state.processedIds.length > PROCESSED_IDS_MAX) {
							state.processedIds = state.processedIds.slice(
								-state.processedIds.length + PROCESSED_IDS_MAX,
							);
						}
						await this.saveState(state);
						logUpdateHandled("processed", item.update);
						continue;
					}
					if (channel.config) {
						(item.update as Update & { __channelConfig?: unknown }).__channelConfig =
							channel.config;
					}
					await runtime.bot.handleUpdate(item.update);
					await touchTelegramSession(this.env, item.update);
					state.processedIds.push(item.id);
					if (state.processedIds.length > PROCESSED_IDS_MAX) {
						state.processedIds = state.processedIds.slice(
							-state.processedIds.length + PROCESSED_IDS_MAX,
						);
					}
					await this.saveState(state);
					logUpdateHandled("processed", item.update);
				} catch (error) {
					console.error("telegram_update_error", error);
					item.attempt += 1;
					if (item.attempt >= MAX_ATTEMPTS) {
						await this.saveState(state);
						continue;
					}
					const delay = Math.min(
						RETRY_BASE_MS * 2 ** (item.attempt - 1),
						RETRY_MAX_MS,
					);
					item.nextAt = Date.now() + delay;
					state.queue.push(item);
					await this.saveState(state);
					await this.state.storage.setAlarm(item.nextAt);
					break;
				}
			}
		} finally {
			this.processing = false;
		}
	}
}

function isCallbackUpdate(
	update: Update,
): update is Update & { callback_query: unknown } {
	return "callback_query" in update;
}

function logUpdateHandled(
	route: "callback_fastpath" | "queued" | "processed",
	update: unknown,
) {
	if (!update || typeof update !== "object") return;
	const record = update as Record<string, unknown>;
	const updateId =
		typeof record.update_id === "number" ? record.update_id : null;
	const hasCallback = "callback_query" in record;
	const hasMessage = "message" in record;
	const updateType = hasCallback
		? "callback_query"
		: hasMessage
			? "message"
			: "other";
	console.log(
		JSON.stringify({
			event: "update_routed",
			route,
			update_id: updateId,
			update_type: updateType,
		}),
	);
}

function isTelegramUpdate(update: unknown): update is Update {
	if (!update || typeof update !== "object") return false;
	return (
		"update_id" in update &&
		typeof (update as { update_id?: unknown }).update_id === "number"
	);
}

function toWorkerResponse(response: Response): WorkerResponse {
	return response as unknown as WorkerResponse;
}

async function handleAdminRequest(request: WorkerRequest, env: Env) {
	const url = new URL(request.url);
	const path = url.pathname;
	if (request.method === "OPTIONS") {
		return withCors(new Response(null, { status: 204 }));
	}
	if (path === "/admin/status" && request.method === "GET") {
		const body = JSON.stringify(
			buildAdminStatusPayload({
				env,
				uptimeSeconds: getUptimeSeconds(),
				sessions: {
					gatewayConnections: activeGatewayConnections,
					activeStreams: streamAbortControllers.size,
				},
			}),
		);
		return withCors(
			new Response(body, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	}
	if (path === "/admin/cron/run" && request.method === "POST") {
		try {
			const reportParts = await buildDailyStatusReportParts({ env });
			const chatId = env.CRON_STATUS_CHAT_ID?.trim();
			if (chatId && env.BOT_TOKEN) {
				await sendDailyStatusMessages(env.BOT_TOKEN as string, chatId, reportParts);
			}
			return withCors(
				new Response(
					JSON.stringify({
						ok: true,
						blocks: reportParts.blocks.length,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		} catch (error) {
			console.error("cron_admin_run_error", error);
			return withCors(
				new Response(
					JSON.stringify({ ok: false, error: String(error) }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				),
			);
		}
	}
	return withCors(new Response("Not found", { status: 404 }));
}

function isWebSocketUpgrade(request: WorkerRequest) {
	return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function toGatewayError(message: string) {
	return { message };
}

function handleGatewayWebSocket(request: WorkerRequest, env: Env): WorkerResponse {
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	let authenticated = false;

	server.accept();
	activeGatewayConnections += 1;
	server.addEventListener("close", () => {
		activeGatewayConnections = Math.max(0, activeGatewayConnections - 1);
	});

	const send = (frame: unknown) => {
		server.send(JSON.stringify(frame));
	};

	const sendResponse = (
		id: string,
		ok: boolean,
		payload?: unknown,
		error?: { message: string },
	) => {
		send({ type: "res", id, ok, payload, error });
	};
	const sendEvent = (streamId: string, payload: Record<string, unknown>) => {
		send({ type: "event", streamId, ...payload });
	};

	server.addEventListener("message", async (event) => {
		const raw = typeof event.data === "string" ? event.data : "";
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			send({ type: "error", error: toGatewayError("invalid_json") });
			return;
		}
		const frame = parsed as {
			type?: unknown;
			id?: unknown;
			method?: unknown;
			params?: unknown;
		};
		if (frame.type !== "req" || typeof frame.id !== "string") {
			send({ type: "error", error: toGatewayError("invalid_frame") });
			return;
		}
		const id = frame.id;
		const method = typeof frame.method === "string" ? frame.method : "";
		const params = frame.params as Record<string, unknown> | undefined;

		if (method === "connect") {
			const token = typeof params?.token === "string" ? params.token : "";
			if (
				!authorizeGatewayToken({
					token,
					expectedToken: env.ADMIN_API_TOKEN,
					allowlist: env.ADMIN_ALLOWLIST,
					clientIp: extractClientIp(request),
				})
			) {
				sendResponse(id, false, undefined, toGatewayError("unauthorized"));
				return;
			}
			authenticated = true;
			let config: GatewayConfig = {};
			try {
				config = await readGatewayConfig(env);
			} catch (error) {
				console.error("gateway_config_read_error", error);
			}
			const effectiveEnv = applyGatewayConfig(env, config);
			const status = buildAdminStatusPayload({
				env: effectiveEnv,
				uptimeSeconds: getUptimeSeconds(),
				sessions: {
					gatewayConnections: activeGatewayConnections,
					activeStreams: streamAbortControllers.size,
				},
			});
			const snapshot = buildGatewayConfigSnapshot(env, config);
			sendResponse(id, true, { status, config: snapshot });
			return;
		}

		if (!authenticated) {
			sendResponse(id, false, undefined, toGatewayError("not_authenticated"));
			return;
		}

		if (method === "config.get") {
			const config = await readGatewayConfig(env);
			const snapshot = buildGatewayConfigSnapshot(env, config);
			sendResponse(id, true, { config: snapshot });
			return;
		}

		if (method === "config.set") {
			const nextConfig = sanitizeGatewayConfig(params?.config);
			const stored = await writeGatewayConfig(env, nextConfig);
			const snapshot = buildGatewayConfigSnapshot(env, stored);
			sendResponse(id, true, { config: snapshot });
			return;
		}

		if (method === "cron.report.run") {
			try {
				const config = await readGatewayConfig(env);
				const effectiveEnv = applyGatewayConfig(env, config);
				const reportParts = await buildDailyStatusReportParts({
					env: effectiveEnv,
				});
				const chatId = effectiveEnv.CRON_STATUS_CHAT_ID?.trim();
				if (chatId && effectiveEnv.BOT_TOKEN) {
					await sendDailyStatusMessages(
						effectiveEnv.BOT_TOKEN as string,
						chatId,
						reportParts,
					);
				}
				sendResponse(id, true, { ok: true, blocks: reportParts.blocks.length });
			} catch (error) {
				sendResponse(id, false, { ok: false }, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "sessions.list") {
			try {
				const response = await callSessions(env, "/list", params ?? {});
				if (!response.ok) {
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("sessions_list_failed"),
					);
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "sessions.patch") {
			try {
				const response = await callSessions(env, "/patch", params ?? {});
				if (!response.ok) {
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("sessions_patch_failed"),
					);
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "sessions.reset") {
			try {
				const response = await callSessions(env, "/reset", params ?? {});
				if (!response.ok) {
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("sessions_reset_failed"),
					);
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "sessions.delete") {
			try {
				const response = await callSessions(env, "/delete", params ?? {});
				if (!response.ok) {
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("sessions_delete_failed"),
					);
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "sessions.resolve") {
			try {
				const response = await callSessions(env, "/resolve", params ?? {});
				if (!response.ok) {
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("sessions_resolve_failed"),
					);
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "channels.list") {
			try {
				const response = await callChannels(env, "/list", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("channels_list_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "channels.patch") {
			try {
				const response = await callChannels(env, "/patch", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("channels_patch_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "wake") {
			try {
				const response = await callCron(env, "/wake", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("wake_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.status") {
			try {
				const response = await callCron(env, "/status", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_status_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.list") {
			try {
				const response = await callCron(env, "/list", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_list_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.add") {
			try {
				const response = await callCron(env, "/add", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_add_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.update") {
			try {
				const response = await callCron(env, "/update", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_update_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.remove") {
			try {
				const response = await callCron(env, "/remove", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_remove_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.run") {
			try {
				const response = await callCron(env, "/run", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_run_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "cron.runs") {
			try {
				const response = await callCron(env, "/runs", params ?? {});
				if (!response.ok) {
					sendResponse(id, false, undefined, toGatewayError("cron_runs_failed"));
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "skills.status") {
			const config = await readGatewayConfig(env);
			const effectiveEnv = applyGatewayConfig(env, config);
			const { report } = buildSkillsStatusReport({
				runtimeSkills,
				env: effectiveEnv,
				config,
			});
			sendResponse(id, true, report);
			return;
		}

		if (method === "skills.update") {
			const skillKey =
				typeof params?.skillKey === "string" ? params.skillKey.trim() : "";
			if (!skillKey) {
				sendResponse(id, false, undefined, toGatewayError("missing_skill_key"));
				return;
			}
			const enabled =
				typeof params?.enabled === "boolean" ? params.enabled : undefined;
			const envPatch =
				params?.env && typeof params.env === "object" ? params.env : undefined;

			const config = await readGatewayConfig(env);
			const skillsConfig = parseSkillsConfig(config);
			const entries = { ...(skillsConfig.entries ?? {}) };
			const current = { ...(entries[skillKey] ?? {}) };

			if (typeof enabled === "boolean") {
				current.enabled = enabled;
			}
			if (envPatch && typeof envPatch === "object") {
				const nextEnv = { ...(current.env ?? {}) };
				for (const [key, value] of Object.entries(envPatch)) {
					const trimmedKey = key.trim();
					if (!trimmedKey) continue;
					const trimmedValue =
						typeof value === "string" ? value.trim() : "";
					if (!trimmedValue) delete nextEnv[trimmedKey];
					else nextEnv[trimmedKey] = trimmedValue;
				}
				current.env = nextEnv;
			}
			entries[skillKey] = current;
			const nextConfig = {
				...config,
				[SKILLS_CONFIG_KEY]: serializeSkillsConfig({ entries }),
			};
			await writeGatewayConfig(env, nextConfig);
			sendResponse(id, true, { ok: true, skillKey, config: current });
			return;
		}

		if (method === "skills.install") {
			sendResponse(id, false, undefined, toGatewayError("install_not_supported"));
			return;
		}

		if (method === "chat.send") {
			const text = typeof params?.text === "string" ? params.text.trim() : "";
			if (!text) {
				sendResponse(id, false, undefined, toGatewayError("empty_text"));
				return;
			}
			const chatId =
				typeof params?.chatId === "string" && params.chatId.trim()
					? params.chatId.trim()
					: "admin";
			const userId =
				typeof params?.userId === "string" && params.userId.trim()
					? params.userId.trim()
					: "admin";
			const userName =
				typeof params?.userName === "string" && params.userName.trim()
					? params.userName.trim()
					: undefined;
			const chatType =
				params?.chatType === "group" ||
				params?.chatType === "supergroup" ||
				params?.chatType === "channel"
					? params.chatType
					: "private";
			const stream = params?.stream === true;
			if (!stream) {
				try {
					const runtime = await getBot(env);
					const result = await runtime.runLocalChat({
						text,
						chatId,
						userId,
						userName,
						chatType,
					});
					await touchAdminSession({ env, chatId, chatType, userName });
					sendResponse(id, true, { messages: result.messages });
				} catch (error) {
					sendResponse(id, false, undefined, toGatewayError(String(error)));
				}
				return;
			}
			const streamId = crypto.randomUUID();
			const abortController = registerStreamAbort(
				streamAbortControllers,
				streamId,
			);
			sendResponse(id, true, { streamId });
			void (async () => {
				try {
					const runtime = await getBot(env);
					const result = await runtime.runLocalChatStream({
						text,
						chatId,
						userId,
						userName,
						chatType,
					}, abortController.signal);
					const reader = result.stream.getReader();
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						if (value) {
							sendEvent(streamId, { chunk: value as Record<string, unknown> });
						}
					}
					await touchAdminSession({ env, chatId, chatType, userName });
					sendEvent(streamId, { done: true });
				} catch (error) {
					sendEvent(streamId, {
						chunk: { type: "error", errorText: String(error) },
					});
					sendEvent(streamId, { done: true });
				} finally {
					streamAbortControllers.delete(streamId);
				}
			})();
			return;
		}

		if (method === "chat.abort") {
			const streamId =
				typeof params?.streamId === "string" ? params.streamId : "";
			if (!streamId) {
				sendResponse(id, false, undefined, toGatewayError("missing_stream_id"));
				return;
			}
			const aborted = abortStream(streamAbortControllers, streamId);
			if (!aborted) {
				sendResponse(id, false, undefined, toGatewayError("stream_not_found"));
				return;
			}
			sendEvent(streamId, { chunk: { type: "abort", reason: "aborted" } });
			sendEvent(streamId, { done: true });
			sendResponse(id, true, { ok: true });
			return;
		}

		sendResponse(id, false, undefined, toGatewayError("unknown_method"));
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

function withCors(response: Response) {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	headers.set(
		"Access-Control-Allow-Headers",
		"Content-Type, Authorization, X-Admin-Token",
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
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

async function sendDailyStatusMessages(
	token: string,
	chatId: string,
	report: { header: string; blocks: string[] },
) {
	for (const block of report.blocks) {
		await sendTelegramMessage(token, chatId, block);
	}
}
