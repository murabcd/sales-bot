import modelsConfig from "../config/models.json";
import { createBot } from "../src/bot.js";

const startTime = Date.now();

type Env = Record<string, string | undefined> & {
	UPDATES_DO: DurableObjectNamespace;
};

let botPromise: Promise<Awaited<ReturnType<typeof createBot>>["bot"]> | null =
	null;

function getUptimeSeconds() {
	return (Date.now() - startTime) / 1000;
}

async function getBot(env: Record<string, string | undefined>) {
	if (!botPromise) {
		botPromise = (async () => {
			const { bot } = await createBot({
				env,
				modelsConfig,
				runtimeSkills: [],
				getUptimeSeconds,
			});
			await bot.init();
			return bot;
		})();
	}
	return botPromise;
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname !== "/telegram") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const update = await request.json();
		const id = env.UPDATES_DO.idFromName("telegram-updates");
		const stub = env.UPDATES_DO.get(id);
		await stub.fetch("https://do/enqueue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(update),
		});
		return new Response("OK", { status: 200 });
	},
};

type QueueItem = {
	id: string;
	update: unknown;
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

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/enqueue") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const update = await request.json();
		if (isCallbackUpdate(update)) {
			const handled = await this.tryHandleCallback(update);
			if (handled) {
				logUpdateHandled("callback_fastpath", update);
				return new Response("OK", { status: 200 });
			}
		}
		await this.enqueueUpdate(update);
		logUpdateHandled("queued", update);
		this.state.waitUntil(this.processQueue());
		return new Response("OK", { status: 200 });
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

	private async enqueueUpdate(update: Record<string, unknown>) {
		const state = await this.loadState();
		const updateId =
			typeof update?.update_id === "number"
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

	private async tryHandleCallback(update: Record<string, unknown>) {
		const updateId =
			typeof update?.update_id === "number" ? String(update.update_id) : null;
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
	update: unknown,
): update is Record<string, unknown> & { callback_query: unknown } {
	if (!update || typeof update !== "object") return false;
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
