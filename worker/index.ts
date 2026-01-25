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
import { loadGatewayPlugins } from "../apps/bot/src/lib/gateway/plugins.js";
import { allowTelegramUpdate } from "../apps/bot/src/lib/gateway/telegram-allowlist.js";
import { buildDailyStatusReportParts } from "../apps/bot/src/lib/reports/daily-status.js";
import { markdownToTelegramHtmlChunks } from "../apps/bot/src/lib/telegram/format.js";

const startTime = Date.now();

type Env = Record<string, string | undefined> & {
	UPDATES_DO: DurableObjectNamespace;
	GATEWAY_CONFIG_DO: DurableObjectNamespace;
};

let botPromise: Promise<Awaited<ReturnType<typeof createBot>>["bot"]> | null =
	null;
let gatewayHooks: ReturnType<typeof loadGatewayPlugins> | null = null;

function getUptimeSeconds() {
	return (Date.now() - startTime) / 1000;
}

async function getBot(env: Record<string, string | undefined>) {
	if (!botPromise) {
		botPromise = (async () => {
			const { bot } = await createBot({
				env,
				modelsConfig,
				runtimeSkills,
				getUptimeSeconds,
			});
			await bot.init();
			return bot;
		})();
	}
	return botPromise;
}

function getGatewayHooks(env: Record<string, string | undefined>) {
	if (!gatewayHooks) {
		gatewayHooks = loadGatewayPlugins(env);
	}
	return gatewayHooks;
}

function parseList(raw: string | undefined) {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function extractClientIp(request: WorkerRequest) {
	return (
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		""
	);
}

function authorizeGatewayToken(
	token: string | undefined,
	request: WorkerRequest,
	env: Env,
) {
	const expected = env.ADMIN_API_TOKEN?.trim() ?? "";
	if (!expected) return false;
	if (!token || token !== expected) return false;
	const allowlist = parseList(env.ADMIN_ALLOWLIST);
	if (allowlist.length === 0) return true;
	const ip = extractClientIp(request);
	return Boolean(ip && allowlist.includes(ip));
}

async function readGatewayConfig(env: Env): Promise<GatewayConfig> {
	const id = env.GATEWAY_CONFIG_DO.idFromName("gateway-config");
	const stub = env.GATEWAY_CONFIG_DO.get(id);
	const response = await stub.fetch("https://do/config");
	if (!response.ok) return {};
	const payload = (await response.json()) as { config?: GatewayConfig };
	return payload.config ?? {};
}

async function writeGatewayConfig(env: Env, config: GatewayConfig) {
	const id = env.GATEWAY_CONFIG_DO.idFromName("gateway-config");
	const stub = env.GATEWAY_CONFIG_DO.get(id);
	const response = await stub.fetch("https://do/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ config }),
	});
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
		const hooks = getGatewayHooks(effectiveEnv);

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
			const ctx = {
				request: adminRequest,
				env,
				url,
				path: url.pathname,
				route: "admin" as const,
			};
			for (const hook of hooks) {
				const outcome = hook.beforeRequest?.(ctx);
				if (outcome && outcome.allow === false) {
					return toWorkerResponse(
						withCors(new Response("Forbidden", { status: 403 })),
					);
				}
			}
			try {
				const response = await handleAdminRequest(request, effectiveEnv);
				const durationMs = Date.now() - startMs;
				for (const hook of hooks) {
					hook.afterRequest?.({ ...ctx, response, durationMs });
				}
				return toWorkerResponse(response);
			} catch (error) {
				const durationMs = Date.now() - startMs;
				for (const hook of hooks) {
					hook.afterRequest?.({
						...ctx,
						durationMs,
						error: String(error),
					});
				}
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
		const ctx = {
			request: telegramRequest,
			env,
			url,
			path: url.pathname,
			route: "telegram" as const,
			update,
		};
		for (const hook of hooks) {
			const outcome = hook.beforeRequest?.(ctx);
			if (outcome && outcome.allow === false) {
				return toWorkerResponse(new Response("OK", { status: 200 }));
			}
		}
		const id = env.UPDATES_DO.idFromName("telegram-updates");
		const stub = env.UPDATES_DO.get(id);
		try {
			await stub.fetch("https://do/enqueue", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(update),
			});
			const durationMs = Date.now() - startMs;
			for (const hook of hooks) {
				hook.afterRequest?.({
					...ctx,
					durationMs,
					response: new Response("OK", { status: 200 }),
				});
			}
			return toWorkerResponse(new Response("OK", { status: 200 }));
		} catch (error) {
			const durationMs = Date.now() - startMs;
			for (const hook of hooks) {
				hook.afterRequest?.({
					...ctx,
					durationMs,
					error: String(error),
				});
			}
			throw error;
		}
	},
	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
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
			const bot = await getBot(this.env);
			await bot.handleUpdate(update);
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
			const bot = await getBot(this.env);
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
					await bot.handleUpdate(item.update);
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

function buildAdminStatusPayload(env: Env) {
	const pluginIds = parseList(env.GATEWAY_PLUGINS).map((id) => id.toLowerCase());
	const allowlist = parseList(env.GATEWAY_PLUGINS_ALLOWLIST).map((id) =>
		id.toLowerCase(),
	);
	const denylist = parseList(env.GATEWAY_PLUGINS_DENYLIST).map((id) =>
		id.toLowerCase(),
	);
	const activePlugins =
		allowlist.length > 0
			? pluginIds.filter((id) => allowlist.includes(id))
			: pluginIds.filter((id) => !denylist.includes(id));
	return {
		serviceName: env.SERVICE_NAME ?? "omni",
		version: env.RELEASE_VERSION ?? "dev",
		commit: env.COMMIT_HASH ?? "local",
		region: env.REGION ?? "local",
		instanceId: env.INSTANCE_ID ?? "local",
		uptimeSeconds: getUptimeSeconds(),
		admin: {
			authRequired: Boolean(env.ADMIN_API_TOKEN?.trim()),
			allowlist: parseList(env.ADMIN_ALLOWLIST),
		},
		gateway: {
			plugins: {
				configured: pluginIds,
				allowlist,
				denylist,
				active: activePlugins,
			},
		},
		cron: {
			enabled: env.CRON_STATUS_ENABLED === "1",
			chatId: env.CRON_STATUS_CHAT_ID ?? "",
			timezone: env.CRON_STATUS_TIMEZONE ?? "Europe/Moscow",
			sprintFilter: env.CRON_STATUS_SPRINT_FILTER ?? "open",
		},
		summary: {
			enabled: env.CRON_STATUS_SUMMARY_ENABLED === "1",
			model: env.CRON_STATUS_SUMMARY_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
		},
	};
}

async function handleAdminRequest(request: WorkerRequest, env: Env) {
	const url = new URL(request.url);
	const path = url.pathname;
	if (request.method === "OPTIONS") {
		return withCors(new Response(null, { status: 204 }));
	}
	if (path === "/admin/status" && request.method === "GET") {
		const body = JSON.stringify(buildAdminStatusPayload(env));
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
			if (!authorizeGatewayToken(token, request, env)) {
				sendResponse(id, false, undefined, toGatewayError("unauthorized"));
				return;
			}
			authenticated = true;
			const config = await readGatewayConfig(env);
			const effectiveEnv = applyGatewayConfig(env, config);
			const status = buildAdminStatusPayload(effectiveEnv);
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

		if (method === "cron.run") {
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
