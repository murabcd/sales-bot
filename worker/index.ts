import type {
	DurableObject,
	DurableObjectNamespace,
	DurableObjectState,
	ExecutionContext,
	R2Bucket,
	Request as WorkerRequest,
	Response as WorkerResponse,
} from "@cloudflare/workers-types";
import type { Update } from "grammy/types";
import modelsConfig from "../apps/bot/config/models.json";
import runtimeSkills from "../apps/bot/config/runtime-skills.json";
import soulConfig from "../apps/bot/config/soul.json";
import bootstrapConfig from "../apps/bot/config/bootstrap.json";
import { createBot } from "../apps/bot/src/bot.js";
import { authorizeAdminRequest } from "../apps/bot/src/lib/gateway/admin-auth.js";
import {
	applyGatewayConfig,
	buildGatewayConfigSnapshot,
	type GatewayConfig,
	sanitizeGatewayConfig,
} from "../apps/bot/src/lib/gateway/config.js";
import { allowTelegramUpdate } from "../apps/bot/src/lib/gateway/telegram-allowlist.js";
import { buildDailyStatusReportParts } from "../apps/bot/src/lib/reports/daily-status.js";
import { markdownToTelegramHtmlChunks } from "../apps/bot/src/lib/telegram/format.js";
import { ChannelsDO } from "./channels-do.js";
import { CronDO } from "./cron-do.js";
import {
	authorizeGatewayToken,
	buildAdminStatusPayload,
} from "./lib/gateway.js";
import {
	cleanupExpiredImagePrefixes,
	createR2ImageStore,
	verifyImageSignature,
} from "./lib/image-store.js";
import {
	buildSkillsStatusReport,
	parseSkillsConfig,
	SKILLS_CONFIG_KEY,
	serializeSkillsConfig,
} from "./lib/skills.js";
import { SessionsDO } from "./sessions-do.js";

const startTime = Date.now();
const SOUL_PROMPT = typeof soulConfig?.text === "string" ? soulConfig.text : "";
const PROJECT_CONTEXT = Array.isArray(bootstrapConfig?.files)
	? bootstrapConfig.files
			.filter(
				(entry) =>
					entry &&
					entry.missing !== true &&
					typeof entry.path === "string" &&
					typeof entry.content === "string" &&
					entry.path.trim() &&
					entry.content.trim(),
			)
			.map((entry) => ({
				path: entry.path.trim(),
				content: entry.content.trim(),
			}))
	: [];
let imageCleanupEnsured: Promise<void> | null = null;

type Env = Record<string, string | undefined> & {
	UPDATES_DO: DurableObjectNamespace;
	UPDATES_PROCESSOR_DO: DurableObjectNamespace;
	GATEWAY_CONFIG_DO: DurableObjectNamespace;
	SESSIONS_DO: DurableObjectNamespace;
	CRON_DO: DurableObjectNamespace;
	CHANNELS_DO: DurableObjectNamespace;
	omni: R2Bucket;
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

function resolveRequiredBotEnv(env: Env) {
	const missing: string[] = [];
	if (!env.BOT_TOKEN?.trim()) missing.push("BOT_TOKEN");
	if (!env.TRACKER_TOKEN?.trim()) missing.push("TRACKER_TOKEN");
	if (!env.OPENAI_API_KEY?.trim()) missing.push("OPENAI_API_KEY");
	if (!env.ALLOWED_TG_IDS?.trim()) missing.push("ALLOWED_TG_IDS");
	const hasTrackerOrg =
		(env.TRACKER_CLOUD_ORG_ID?.trim() ?? "") ||
		(env.TRACKER_ORG_ID?.trim() ?? "");
	if (!hasTrackerOrg) {
		missing.push("TRACKER_CLOUD_ORG_ID|TRACKER_ORG_ID");
	}
	return missing;
}

function resolveImageRetentionDays(env: Env) {
	const value = Number.parseInt(env.IMAGE_RETENTION_DAYS ?? "7", 10);
	return Number.isFinite(value) && value > 0 ? value : 7;
}

function resolveImageSigningSecret(env: Env) {
	return env.IMAGE_SIGNING_SECRET?.trim() ?? "";
}

function resolvePublicBaseUrl(env: Env) {
	return env.PUBLIC_BASE_URL?.trim() ?? "";
}

function getImageStore(env: Env) {
	const signingSecret = resolveImageSigningSecret(env);
	if (!signingSecret) return null;
	return createR2ImageStore({
		bucket: env.omni,
		baseUrl: resolvePublicBaseUrl(env),
		signingSecret,
		retentionDays: resolveImageRetentionDays(env),
	});
}

async function ensureImageCleanupJob(env: Env) {
	if (imageCleanupEnsured) return imageCleanupEnsured;
	imageCleanupEnsured = (async () => {
		const response = await callCron(env, "/list", {});
		if (!response.ok) return;
		const payload = (await response.json()) as { jobs?: Array<{ id?: string }> };
		const exists = (payload.jobs ?? []).some((job) => job.id === "image-cleanup");
		if (exists) return;
		const now = Date.now();
		await callCron(env, "/add", {
			id: "image-cleanup",
			name: "Image cleanup",
			description: "Delete expired images from R2.",
			enabled: true,
			createdAtMs: now,
			updatedAtMs: now,
			schedule: { kind: "cron", expr: "30 3 * * *", tz: "UTC" },
			sessionTarget: "main",
			wakeMode: "now",
			payload: { kind: "imageCleanup" },
		});
	})();
	return imageCleanupEnsured;
}

async function getBot(env: Record<string, string | undefined>) {
	if (!botPromise) {
		botPromise = (async () => {
			const effectiveEnv = {
				...env,
				...(SOUL_PROMPT.trim().length > 0 ? { SOUL_PROMPT } : {}),
				...(PROJECT_CONTEXT.length > 0
					? { PROJECT_CONTEXT: JSON.stringify(PROJECT_CONTEXT) }
					: {}),
			};
			const typedEnv = env as Env;
			const imageStore = getImageStore(typedEnv);
			if (imageStore) {
				await ensureImageCleanupJob(typedEnv);
			}
			const cronClient = {
				list: async (params?: { includeDisabled?: boolean }) => {
					const response = await callCron(env as Env, "/list", params ?? {});
					if (!response.ok) {
						throw new Error("cron_list_failed");
					}
					return (await response.json()) as { jobs?: unknown[] };
				},
				add: async (params: Record<string, unknown>) => {
					const response = await callCron(env as Env, "/add", params);
					if (!response.ok) {
						throw new Error("cron_add_failed");
					}
					return response.json();
				},
				remove: async (params: { jobId: string }) => {
					const response = await callCron(env as Env, "/remove", params);
					if (!response.ok) {
						throw new Error("cron_remove_failed");
					}
					return response.json();
				},
				run: async (params: { jobId: string; mode?: "due" | "force" }) => {
					const response = await callCron(env as Env, "/run", params);
					if (!response.ok) {
						throw new Error("cron_run_failed");
					}
					return response.json();
				},
				update: async (params: {
					id?: string;
					jobId?: string;
					patch: Record<string, unknown>;
				}) => {
					const response = await callCron(env as Env, "/update", params);
					if (!response.ok) {
						throw new Error("cron_update_failed");
					}
					return response.json();
				},
				runs: async (params: {
					id?: string;
					jobId?: string;
					limit?: number;
				}) => {
					const response = await callCron(env as Env, "/runs", params);
					if (!response.ok) {
						throw new Error("cron_runs_failed");
					}
					return response.json();
				},
				status: async () => {
					const response = await callCron(env as Env, "/status", {});
					if (!response.ok) {
						throw new Error("cron_status_failed");
					}
					return response.json();
				},
			};
			const sessionClient = {
				get: async (params: { key: string }) => {
					const response = await callSessions(env as Env, "/get", params);
					if (response.status === 404) {
						return { ok: true, entry: undefined };
					}
					if (!response.ok) {
						throw new Error("sessions_get_failed");
					}
					return response.json();
				},
				patch: async (params: { key: string; timeZone?: string | null }) => {
					const response = await callSessions(env as Env, "/patch", params);
					if (!response.ok) {
						throw new Error("sessions_patch_failed");
					}
					return response.json();
				},
			};
			const runtime = await createBot({
				env: effectiveEnv,
				modelsConfig,
				runtimeSkills,
				getUptimeSeconds,
				cronClient,
				sessionClient,
				imageStore: imageStore ?? undefined,
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

async function callCron(
	env: Env,
	path: string,
	params: Record<string, unknown>,
) {
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

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
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
		(payload.message as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(payload.edited_message as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(payload.channel_post as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(payload.edited_channel_post as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(
			payload.callback_query as
				| {
						message?: { chat?: { id?: number; type?: string; title?: string } };
				  }
				| undefined
		)?.message ??
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
		(payload.message as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(payload.edited_message as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(payload.channel_post as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(payload.edited_channel_post as
			| { chat?: { id?: number; type?: string; title?: string } }
			| undefined) ??
		(
			payload.callback_query as
				| {
						message?: { chat?: { id?: number; type?: string; title?: string } };
				  }
				| undefined
		)?.message ??
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

function resolveTelegramThreadId(update: Update) {
	const payload = (update as Update & Record<string, unknown>) ?? {};
	const message =
		(payload.message as { message_thread_id?: number } | undefined) ??
		(payload.edited_message as { message_thread_id?: number } | undefined) ??
		(payload.channel_post as { message_thread_id?: number } | undefined) ??
		(payload.edited_channel_post as
			| { message_thread_id?: number }
			| undefined) ??
		(
			payload.callback_query as
				| { message?: { message_thread_id?: number } }
				| undefined
		)?.message ??
		undefined;
	const threadId = message?.message_thread_id;
	return typeof threadId === "number" ? threadId : undefined;
}

type ChannelConfig = {
	enabled?: boolean;
	requireMention?: boolean;
	allowUserIds?: string[];
	skillsAllowlist?: string[];
	skillsDenylist?: string[];
	systemPrompt?: string;
};

function mergeChannelConfig(
	base?: ChannelConfig,
	override?: ChannelConfig,
): ChannelConfig | undefined {
	if (!base && !override) return undefined;
	return {
		enabled: override?.enabled ?? base?.enabled,
		requireMention: override?.requireMention ?? base?.requireMention,
		allowUserIds: Array.isArray(override?.allowUserIds)
			? override.allowUserIds
			: base?.allowUserIds,
		skillsAllowlist: Array.isArray(override?.skillsAllowlist)
			? override.skillsAllowlist
			: base?.skillsAllowlist,
		skillsDenylist: Array.isArray(override?.skillsDenylist)
			? override.skillsDenylist
			: base?.skillsDenylist,
		systemPrompt: override?.systemPrompt ?? base?.systemPrompt,
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

	const groupResponse = await callChannels(env, "/touch", channel);
	const groupPayload = groupResponse.ok
		? ((await groupResponse.json()) as { entry?: ChannelConfig })
		: undefined;
	const groupConfig = groupPayload?.entry;

	const threadId = resolveTelegramThreadId(update);
	if (!threadId) {
		return {
			enabled: groupConfig?.enabled !== false,
			config: groupConfig,
		};
	}

	const topic = {
		...channel,
		key: `${channel.key}:${threadId}`,
	};
	const topicResponse = await callChannels(env, "/touch", topic);
	const topicPayload = topicResponse.ok
		? ((await topicResponse.json()) as { entry?: ChannelConfig })
		: undefined;
	const mergedConfig = mergeChannelConfig(groupConfig, topicPayload?.entry);

	return {
		enabled: mergedConfig?.enabled !== false,
		config: mergedConfig,
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

async function handleHealthCheck(env: Env): Promise<Response> {
	const uptimeSeconds = getUptimeSeconds();
	const checks: Record<
		string,
		{ status: "ok" | "error"; latencyMs?: number; error?: string }
	> = {};

	// Check Sessions DO
	try {
		const start = Date.now();
		const response = await withTimeout(
			callSessions(env, "/list", { limit: 1 }),
			2_000,
		);
		checks.sessions = {
			status: response.ok ? "ok" : "error",
			latencyMs: Date.now() - start,
		};
	} catch (error) {
		checks.sessions = { status: "error", error: String(error) };
	}

	// Check Cron DO
	try {
		const start = Date.now();
		const response = await withTimeout(callCron(env, "/list", {}), 2_000);
		checks.cron = {
			status: response.ok ? "ok" : "error",
			latencyMs: Date.now() - start,
		};
	} catch (error) {
		checks.cron = { status: "error", error: String(error) };
	}

	// Check Channels DO
	try {
		const start = Date.now();
		const response = await withTimeout(
			callChannels(env, "/list", { limit: 1 }),
			2_000,
		);
		checks.channels = {
			status: response.ok ? "ok" : "error",
			latencyMs: Date.now() - start,
		};
	} catch (error) {
		checks.channels = { status: "error", error: String(error) };
	}

	const allHealthy = Object.values(checks).every((c) => c.status === "ok");

	return new Response(
		JSON.stringify({
			status: allHealthy ? "healthy" : "degraded",
			uptimeSeconds: Math.round(uptimeSeconds),
			checks,
			timestamp: new Date().toISOString(),
		}),
		{
			status: allHealthy ? 200 : 503,
			headers: { "Content-Type": "application/json" },
		},
	);
}

async function handleTelegramHealthCheck(env: Env): Promise<Response> {
	const token = env.BOT_TOKEN?.trim();
	if (!token) {
		return new Response(
			JSON.stringify({ ok: false, error: "BOT_TOKEN is unset" }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
	const url = `https://api.telegram.org/bot${token}/getMe`;
	try {
		const start = Date.now();
		const response = await withTimeout(fetch(url), 3_000);
		const body = await response.text();
		return new Response(
			JSON.stringify({
				ok: response.ok,
				status: response.status,
				latencyMs: Date.now() - start,
				body,
			}),
			{ status: response.ok ? 200 : 503, headers: { "Content-Type": "application/json" } },
		);
	} catch (error) {
		return new Response(
			JSON.stringify({ ok: false, error: String(error) }),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		);
	}
}

async function handleFigmaHealthCheck(env: Env): Promise<Response> {
	const token = env.FIGMA_TOKEN?.trim();
	if (!token) {
		return new Response(
			JSON.stringify({ ok: false, error: "FIGMA_TOKEN is unset" }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
	try {
		const start = Date.now();
		const response = await withTimeout(
			fetch("https://api.figma.com/v1/me", {
				headers: { "X-Figma-Token": token },
			}),
			3_000,
		);
		const body = await response.text();
		return new Response(
			JSON.stringify({
				ok: response.ok,
				status: response.status,
				latencyMs: Date.now() - start,
				body,
			}),
			{ status: response.ok ? 200 : 503, headers: { "Content-Type": "application/json" } },
		);
	} catch (error) {
		return new Response(
			JSON.stringify({ ok: false, error: String(error) }),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		);
	}
}

export default {
	async fetch(
		request: WorkerRequest,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<WorkerResponse> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return toWorkerResponse(await handleHealthCheck(env));
		}

		if (url.pathname === "/health/telegram") {
			return toWorkerResponse(await handleTelegramHealthCheck(env));
		}
		if (url.pathname === "/health/figma") {
			return toWorkerResponse(await handleFigmaHealthCheck(env));
		}

		if (url.pathname.startsWith("/media/") && request.method === "GET") {
			const signingSecret = resolveImageSigningSecret(env);
			if (!signingSecret) {
				return toWorkerResponse(new Response("image_signing_secret_missing", { status: 500 }));
			}
			const keyEncoded = url.pathname.slice("/media/".length);
			if (!keyEncoded) {
				return toWorkerResponse(new Response("missing_key", { status: 400 }));
			}
			const key = decodeURIComponent(keyEncoded);
			const expRaw = url.searchParams.get("exp") ?? "";
			const sig = url.searchParams.get("sig") ?? "";
			const exp = Number.parseInt(expRaw, 10);
			if (!exp || !sig) {
				return toWorkerResponse(new Response("invalid_signature", { status: 400 }));
			}
			if (!verifyImageSignature({ signingSecret, key, exp, sig })) {
				return toWorkerResponse(new Response("signature_mismatch", { status: 403 }));
			}
			if (Date.now() > exp) {
				await env.omni.delete(key);
				return toWorkerResponse(new Response("expired", { status: 410 }));
			}
			const object = await env.omni.get(key);
			if (!object) {
				return toWorkerResponse(new Response("not_found", { status: 404 }));
			}
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set("Cache-Control", "private, max-age=3600");
			return toWorkerResponse(new Response(object.body, { status: 200, headers }));
		}

		if (url.pathname === "/gateway" && isWebSocketUpgrade(request)) {
			return handleGatewayWebSocket(request, env);
		}
		const route = url.pathname.startsWith("/admin")
			? "admin"
			: url.pathname === "/telegram"
				? "telegram"
				: "other";
		const config = await readGatewayConfig(env);
		const effectiveEnv = applyGatewayConfig(env, config) as Env;

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
			const response = await handleAdminRequest(request, effectiveEnv);
			return toWorkerResponse(response);
		}
		if (url.pathname !== "/telegram") {
			return toWorkerResponse(new Response("Not found", { status: 404 }));
		}
		if (request.method !== "POST") {
			return toWorkerResponse(
				new Response("Method Not Allowed", { status: 405 }),
			);
		}
		const missingEnv = resolveRequiredBotEnv(effectiveEnv);
		if (missingEnv.length > 0) {
			return toWorkerResponse(
				new Response(
					JSON.stringify({ ok: false, error: "missing_env", missing: missingEnv }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				),
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
		const id = env.UPDATES_DO.idFromName("telegram-updates");
		const stub = env.UPDATES_DO.get(id);
		await stub.fetch("https://do/enqueue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(update),
		});
		return toWorkerResponse(new Response("OK", { status: 200 }));
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
	lockedUntil?: number;
};

type StoredState = {
	queue: QueueItem[];
	processedIds: string[];
};

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const PROCESSED_IDS_MAX = 1_000;
const PROCESS_BUDGET_MS = 1_500;
const QUEUE_LOCK_MS = 60_000;

export class TelegramUpdatesDO implements DurableObject {
	private state: DurableObjectState;
	private env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: WorkerRequest): Promise<WorkerResponse> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/enqueue") {
			const update = await request.json();
			if (!isTelegramUpdate(update)) {
				return toWorkerResponse(new Response("Bad Request", { status: 400 }));
			}
			await this.enqueueUpdate(update);
			logUpdateHandled("queued", update);
			this.state.waitUntil(this.kickProcessor());
			return toWorkerResponse(new Response("OK", { status: 200 }));
		}
		if (request.method === "POST" && url.pathname === "/dequeue") {
			const state = await this.loadState();
			if (state.queue.length === 0) {
				return toWorkerResponse(
					new Response(JSON.stringify({ ok: false, nextAt: null }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			const now = Date.now();
			let bestIndex = -1;
			let bestNextAt = Number.POSITIVE_INFINITY;
			for (let i = 0; i < state.queue.length; i += 1) {
				const candidate = state.queue[i];
				if (!candidate) continue;
				if (candidate.nextAt > now) continue;
				if (candidate.lockedUntil && candidate.lockedUntil > now) continue;
				if (candidate.nextAt < bestNextAt) {
					bestNextAt = candidate.nextAt;
					bestIndex = i;
				}
			}
			const item = bestIndex >= 0 ? state.queue[bestIndex] : null;
			if (!item) {
				state.queue.sort((a, b) => a.nextAt - b.nextAt);
				const nextItem = state.queue[0];
				return toWorkerResponse(
					new Response(
						JSON.stringify({
							ok: false,
							nextAt: nextItem ? nextItem.nextAt : null,
						}),
						{
						status: 200,
						headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			item.lockedUntil = now + QUEUE_LOCK_MS;
			await this.saveState(state);
			return toWorkerResponse(
				new Response(JSON.stringify({ ok: true, item }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		if (request.method === "POST" && url.pathname === "/requeue") {
			const body = (await request.json()) as QueueItem;
			if (!body?.id || !body.update) {
				return toWorkerResponse(new Response("Bad Request", { status: 400 }));
			}
			const state = await this.loadState();
			const existing = state.queue.find((item) => item.id === body.id);
			if (existing) {
				existing.attempt = body.attempt;
				existing.nextAt = body.nextAt;
				existing.lockedUntil = undefined;
			} else {
				state.queue.push({ ...body, lockedUntil: undefined });
			}
			await this.saveState(state);
			return toWorkerResponse(new Response("OK", { status: 200 }));
		}
		if (request.method === "POST" && url.pathname === "/processed") {
			const body = (await request.json()) as { id?: string };
			if (!body?.id) {
				return toWorkerResponse(new Response("Bad Request", { status: 400 }));
			}
			const state = await this.loadState();
			state.queue = state.queue.filter((item) => item.id !== body.id);
			state.processedIds.push(body.id);
			if (state.processedIds.length > PROCESSED_IDS_MAX) {
				state.processedIds = state.processedIds.slice(
					-state.processedIds.length + PROCESSED_IDS_MAX,
				);
			}
			await this.saveState(state);
			return toWorkerResponse(new Response("OK", { status: 200 }));
		}
		return toWorkerResponse(new Response("Not found", { status: 404 }));
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
	private async kickProcessor() {
		const id =
			this.env.UPDATES_PROCESSOR_DO.idFromName("telegram-updates-processor");
		const stub = this.env.UPDATES_PROCESSOR_DO.get(id);
		await stub.fetch("https://do/process", { method: "POST" });
	}
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

export class TelegramUpdatesProcessorDO implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private processing = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: WorkerRequest): Promise<WorkerResponse> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/process") {
			this.state.waitUntil(this.processQueue());
			return toWorkerResponse(new Response("OK", { status: 200 }));
		}
		return toWorkerResponse(new Response("Not found", { status: 404 }));
	}

	async alarm(): Promise<void> {
		await this.processQueue();
	}

	private async dequeue(): Promise<
		{ ok: true; item: QueueItem } | { ok: false; nextAt: number | null }
	> {
		const id = this.env.UPDATES_DO.idFromName("telegram-updates");
		const stub = this.env.UPDATES_DO.get(id);
		const response = await stub.fetch("https://do/dequeue", { method: "POST" });
		return (await response.json()) as
			| { ok: true; item: QueueItem }
			| { ok: false; nextAt: number | null };
	}

	private async markProcessed(id: string) {
		const stub = this.env.UPDATES_DO.get(
			this.env.UPDATES_DO.idFromName("telegram-updates"),
		);
		await stub.fetch("https://do/processed", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
	}

	private async requeue(item: QueueItem) {
		const stub = this.env.UPDATES_DO.get(
			this.env.UPDATES_DO.idFromName("telegram-updates"),
		);
		await stub.fetch("https://do/requeue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(item),
		});
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		const startedAt = Date.now();
		try {
			const runtime = await getBot(this.env);

			while (Date.now() - startedAt < PROCESS_BUDGET_MS) {
				const dequeued = await this.dequeue();
				if (!dequeued.ok) {
					if (dequeued.nextAt) {
						await this.state.storage.setAlarm(dequeued.nextAt);
					}
					break;
				}
				const item = dequeued.item;
				let startedItemAt: number | null = null;
				try {
					const channel = await touchTelegramChannel(this.env, item.update);
					if (!channel.enabled) {
						await this.markProcessed(item.id);
						logBotInvocation("bot_invocation_end", item.update, {
							route: "processed",
							stream: false,
							status: "skipped",
							reason: "channel_disabled",
							elapsed_ms: 0,
						});
						logUpdateHandled("processed", item.update);
						continue;
					}
					if (channel.config) {
						(
							item.update as Update & { __channelConfig?: unknown }
						).__channelConfig = channel.config;
					}
					startedItemAt = Date.now();
					logBotInvocation("bot_invocation_start", item.update, {
						route: "processed",
						stream: false,
					});
					await runtime.bot.handleUpdate(item.update);
					await touchTelegramSession(this.env, item.update);
					logBotInvocation("bot_invocation_end", item.update, {
						route: "processed",
						stream: false,
						status: "ok",
						elapsed_ms: startedItemAt ? Date.now() - startedItemAt : null,
					});
					await this.markProcessed(item.id);
					logUpdateHandled("processed", item.update);
				} catch (error) {
					logBotInvocation("bot_invocation_end", item.update, {
						route: "processed",
						stream: false,
						status: "error",
						error: String(error),
						elapsed_ms: startedItemAt ? Date.now() - startedItemAt : null,
					});
					console.error("telegram_update_error", error);
					item.attempt += 1;
					if (item.attempt >= MAX_ATTEMPTS) {
						await this.markProcessed(item.id);
						continue;
					}
					const delay = Math.min(
						RETRY_BASE_MS * 2 ** (item.attempt - 1),
						RETRY_MAX_MS,
					);
					item.nextAt = Date.now() + delay;
					await this.requeue(item);
					await this.state.storage.setAlarm(item.nextAt);
					break;
				}
			}
		} finally {
			this.processing = false;
		}
	}
}

function logBotInvocation(
	event: "bot_invocation_start" | "bot_invocation_end",
	update: Update,
	extra: Record<string, unknown>,
) {
	const updateId =
		typeof update.update_id === "number" ? update.update_id : null;
	const message = "message" in update ? update.message : null;
	const callbackMessage =
		"callback_query" in update && update.callback_query
			? update.callback_query.message
			: null;
	const chatId =
		message?.chat?.id ??
		(callbackMessage && "chat" in callbackMessage
			? callbackMessage.chat?.id
			: null) ??
		null;
	const userId =
		message?.from?.id ??
		(callbackMessage && "from" in callbackMessage
			? callbackMessage.from?.id
			: null) ??
		null;
	const updateType = "callback_query" in update ? "callback_query" : "message";
	console.log(
		JSON.stringify({
			event,
			update_id: updateId,
			update_type: updateType,
			chat_id: chatId ?? null,
			user_id: userId ?? null,
			...extra,
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
	if (path === "/admin/prompt-report" && request.method === "GET") {
		try {
			const channelKey = url.searchParams.get("channelKey")?.trim() ?? "";
			const chatId = url.searchParams.get("chatId")?.trim() ?? "";
			let channelConfig:
				| {
						systemPrompt?: string;
						requireMention?: boolean;
						allowUserIds?: string[];
						skillsAllowlist?: string[];
						skillsDenylist?: string[];
				  }
				| undefined;
			if (channelKey) {
				const response = await callChannels(env, "/get", { key: channelKey });
				if (response.ok) {
					const payload = (await response.json()) as {
						entry?: {
							systemPrompt?: string;
							requireMention?: boolean;
							allowUserIds?: string[];
							skillsAllowlist?: string[];
							skillsDenylist?: string[];
						};
					};
					channelConfig = payload.entry;
				}
			}
			const botRuntime = await getBot(env);
			const report = await botRuntime.buildPromptReport({
				chatId: chatId || undefined,
				channelConfig,
			});
			return withCors(
				new Response(JSON.stringify(report), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		} catch (error) {
			console.error("prompt_report_error", error);
			return withCors(
				new Response(JSON.stringify({ ok: false, error: String(error) }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
	}
	if (path === "/admin/cron/run" && request.method === "POST") {
		try {
			const reportParts = await buildDailyStatusReportParts({ env });
			const chatId = env.CRON_STATUS_CHAT_ID?.trim();
			if (chatId && env.BOT_TOKEN) {
				await sendDailyStatusMessages(
					env.BOT_TOKEN as string,
					chatId,
					reportParts,
				);
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
				new Response(JSON.stringify({ ok: false, error: String(error) }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				}),
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

type ServerWebSocket = WebSocket & {
	accept: () => void;
};

type WebSocketPair = {
	0: WebSocket;
	1: ServerWebSocket;
};

declare const WebSocketPair: {
	new (): WebSocketPair;
};

function handleGatewayWebSocket(
	request: WorkerRequest,
	env: Env,
): WorkerResponse {
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("channels_list_failed"),
					);
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("channels_patch_failed"),
					);
					return;
				}
				sendResponse(id, true, await response.json());
			} catch (error) {
				sendResponse(id, false, undefined, toGatewayError(String(error)));
			}
			return;
		}

		if (method === "prompt.report") {
			try {
				const botRuntime = await getBot(env);
				const rawParams = (params as
					| {
							chatId?: string;
							channelKey?: string;
							channelConfig?: {
								systemPrompt?: string;
								requireMention?: boolean;
								allowUserIds?: string[];
								skillsAllowlist?: string[];
								skillsDenylist?: string[];
							};
							question?: string;
							promptMode?: "full" | "minimal" | "none";
					  }
					| undefined) ?? {};
				let channelConfig = rawParams.channelConfig;
				if (!channelConfig && rawParams.channelKey) {
					const response = await callChannels(env, "/get", {
						key: rawParams.channelKey,
					});
					if (response.ok) {
						const payload = (await response.json()) as {
							entry?: {
								systemPrompt?: string;
								requireMention?: boolean;
								allowUserIds?: string[];
								skillsAllowlist?: string[];
								skillsDenylist?: string[];
							};
						};
						channelConfig = payload.entry;
					}
				}
				const report = await botRuntime.buildPromptReport({
					chatId: rawParams.chatId,
					channelConfig,
					question: rawParams.question,
					promptMode: rawParams.promptMode,
				});
				sendResponse(id, true, report);
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("cron_status_failed"),
					);
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("cron_list_failed"),
					);
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("cron_update_failed"),
					);
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("cron_remove_failed"),
					);
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
					sendResponse(
						id,
						false,
						undefined,
						toGatewayError("cron_runs_failed"),
					);
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
					const trimmedValue = typeof value === "string" ? value.trim() : "";
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
			sendResponse(
				id,
				false,
				undefined,
				toGatewayError("install_not_supported"),
			);
			return;
		}

		if (method === "chat.send") {
			const text = typeof params?.text === "string" ? params.text.trim() : "";
			const files = Array.isArray(params?.files)
				? params.files.filter(
						(
							file,
						): file is { mediaType: string; url: string; filename?: string } =>
							typeof file === "object" &&
							file !== null &&
							typeof (file as { mediaType?: unknown }).mediaType === "string" &&
							typeof (file as { url?: unknown }).url === "string",
					)
				: [];
			const webSearchEnabled =
				typeof params?.webSearchEnabled === "boolean"
					? params.webSearchEnabled
					: undefined;
			if (!text && files.length === 0) {
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
				let startedAt: number | null = null;
				try {
					startedAt = Date.now();
					console.log(
						JSON.stringify({
							event: "bot_invocation_start",
							chat_id: chatId,
							user_id: userId,
							chat_type: chatType,
							has_files: files.length > 0,
							web_search_enabled: webSearchEnabled ?? null,
							stream: false,
						}),
					);
					const runtime = await getBot(env);
					const result = await runtime.runLocalChat({
						text,
						files,
						webSearchEnabled,
						chatId,
						userId,
						userName,
						chatType,
					});
					await touchAdminSession({ env, chatId, chatType, userName });
					console.log(
						JSON.stringify({
							event: "bot_invocation_end",
							chat_id: chatId,
							user_id: userId,
							chat_type: chatType,
							stream: false,
							status: "ok",
							elapsed_ms: startedAt ? Date.now() - startedAt : null,
						}),
					);
					sendResponse(id, true, { messages: result.messages });
				} catch (error) {
					console.log(
						JSON.stringify({
							event: "bot_invocation_end",
							chat_id: chatId,
							user_id: userId,
							chat_type: chatType,
							stream: false,
							status: "error",
							error: String(error),
							elapsed_ms: startedAt ? Date.now() - startedAt : null,
						}),
					);
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
				let startedAt: number | null = null;
				try {
					startedAt = Date.now();
					console.log(
						JSON.stringify({
							event: "bot_invocation_start",
							chat_id: chatId,
							user_id: userId,
							chat_type: chatType,
							has_files: files.length > 0,
							web_search_enabled: webSearchEnabled ?? null,
							stream: true,
							stream_id: streamId,
						}),
					);
					const runtime = await getBot(env);
					const result = await runtime.runLocalChatStream(
						{
							text,
							files,
							webSearchEnabled,
							chatId,
							userId,
							userName,
							chatType,
						},
						abortController.signal,
					);
					const reader = result.stream.getReader();
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						if (value) {
							sendEvent(streamId, { chunk: value as Record<string, unknown> });
						}
					}
					await touchAdminSession({ env, chatId, chatType, userName });
					console.log(
						JSON.stringify({
							event: "bot_invocation_end",
							chat_id: chatId,
							user_id: userId,
							chat_type: chatType,
							stream: true,
							stream_id: streamId,
							status: "ok",
							elapsed_ms: startedAt ? Date.now() - startedAt : null,
						}),
					);
					sendEvent(streamId, { done: true });
				} catch (error) {
					console.log(
						JSON.stringify({
							event: "bot_invocation_end",
							chat_id: chatId,
							user_id: userId,
							chat_type: chatType,
							stream: true,
							stream_id: streamId,
							status: "error",
							error: String(error),
							elapsed_ms: startedAt ? Date.now() - startedAt : null,
						}),
					);
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

	return toWorkerResponse(
		new Response(null, {
			status: 101,
			webSocket: client,
		} as ResponseInit & { webSocket: WebSocket }),
	);
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
