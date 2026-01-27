"use client";

import type { SkillStatusReport } from "@/lib/skills-types";

export type GatewayRequestFrame = {
	type: "req";
	id: string;
	method: string;
	params?: unknown;
};

export type GatewayResponseFrame = {
	type: "res";
	id: string;
	ok: boolean;
	payload?: unknown;
	error?: { message?: string };
};

export type GatewayEventFrame = {
	type: "event";
	streamId: string;
	chunk?: unknown;
	done?: boolean;
	error?: { message?: string };
};

export type GatewayConfig = Record<string, string>;

export type GatewayConnectPayload = {
	status: unknown;
	config: GatewayConfig;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
};

function toWsUrl(baseUrl: string) {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/gateway";
	url.search = "";
	return url.toString();
}

export class GatewayClient {
	private ws: WebSocket | null = null;
	private pending = new Map<string, PendingRequest>();
	private opening: Promise<void> | null = null;
	private streams = new Map<string, ReadableStreamDefaultController<unknown>>();

	constructor(
		private opts: {
			url: string;
			token: string;
		},
	) {}

	private async ensureOpen() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
		if (this.opening) return this.opening;
		this.opening = new Promise<void>((resolve, reject) => {
			const wsUrl = toWsUrl(this.opts.url);
			const ws = new WebSocket(wsUrl);
			this.ws = ws;
			ws.onopen = () => resolve();
			ws.onerror = (event) => reject(event);
			ws.onclose = () => {
				this.ws = null;
				for (const [, pending] of this.pending) {
					pending.reject(new Error("gateway_disconnected"));
				}
				this.pending.clear();
				for (const [, controller] of this.streams) {
					controller.error(new Error("gateway_disconnected"));
				}
				this.streams.clear();
			};
			ws.onmessage = (event) => this.handleMessage(event.data);
		}).finally(() => {
			this.opening = null;
		});
		return this.opening;
	}

	private handleMessage(raw: unknown) {
		if (typeof raw !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		const frame = parsed as GatewayResponseFrame | GatewayEventFrame;
		if (frame.type === "res" && typeof frame.id === "string") {
			const pending = this.pending.get(frame.id);
			if (!pending) return;
			this.pending.delete(frame.id);
			if (frame.ok) {
				pending.resolve(frame.payload);
			} else {
				pending.reject(new Error(frame.error?.message ?? "request_failed"));
			}
			return;
		}
		if (frame.type === "event" && typeof frame.streamId === "string") {
			const controller = this.streams.get(frame.streamId);
			if (!controller) return;
			if (frame.chunk) {
				controller.enqueue(frame.chunk);
			}
			if (frame.done) {
				controller.close();
				this.streams.delete(frame.streamId);
			}
			if (frame.error?.message) {
				controller.error(new Error(frame.error.message));
				this.streams.delete(frame.streamId);
			}
		}
	}

	private async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		await this.ensureOpen();
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("gateway_not_connected");
		}
		const id = crypto.randomUUID();
		const frame: GatewayRequestFrame = { type: "req", id, method, params };
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.ws.send(JSON.stringify(frame));
		return promise;
	}

	connect(): Promise<GatewayConnectPayload> {
		return this.request("connect", { token: this.opts.token });
	}

	async getConfig(): Promise<GatewayConfig> {
		const payload = (await this.request("config.get")) as { config?: GatewayConfig };
		return payload.config ?? {};
	}

	async setConfig(next: GatewayConfig): Promise<GatewayConfig> {
		const payload = (await this.request("config.set", {
			config: next,
		})) as { config?: GatewayConfig };
		return payload.config ?? {};
	}

	runCron(): Promise<{ ok: boolean; blocks?: number; error?: string }> {
		return this.request("cron.report.run");
	}

	cronStatus(): Promise<unknown> {
		return this.request("cron.status");
	}

	cronList(params?: { includeDisabled?: boolean }): Promise<{ jobs?: unknown[] }> {
		return this.request("cron.list", params ?? {});
	}

	cronAdd(params: unknown): Promise<unknown> {
		return this.request("cron.add", params);
	}

	cronUpdate(params: { id?: string; jobId?: string; patch: unknown }): Promise<unknown> {
		return this.request("cron.update", params);
	}

	cronRemove(params: { id?: string; jobId?: string }): Promise<{ ok?: boolean }> {
		return this.request("cron.remove", params);
	}

	cronRun(params: { id?: string; jobId?: string; mode?: "due" | "force" }): Promise<{ ok?: boolean }> {
		return this.request("cron.run", params);
	}

	cronRuns(params: { id?: string; jobId?: string; limit?: number }): Promise<{ entries?: unknown[] }> {
		return this.request("cron.runs", params);
	}

	channelsList(params?: { includeDisabled?: boolean; limit?: number }): Promise<{ entries?: unknown[] }> {
		return this.request("channels.list", params ?? {});
	}

	channelsPatch(params: {
		key: string;
		enabled?: boolean;
		label?: string | null;
		requireMention?: boolean;
		allowUserIds?: string[];
		skillsAllowlist?: string[];
		skillsDenylist?: string[];
		systemPrompt?: string | null;
	}): Promise<unknown> {
		return this.request("channels.patch", params);
	}

	sessionsList(params?: {
		activeMinutes?: number | string;
		limit?: number | string;
		includeGlobal?: boolean;
		includeUnknown?: boolean;
		label?: string;
		spawnedBy?: string;
		agentId?: string;
	}): Promise<unknown> {
		return this.request("sessions.list", params ?? {});
	}

	sessionsPatch(params: {
		key: string;
		thinkingLevel?: string | null;
		verboseLevel?: string | null;
		reasoningLevel?: string | null;
		label?: string | null;
		spawnedBy?: string | null;
		agentId?: string | null;
		responseUsage?: "off" | "tokens" | "full" | "on" | null;
		sendPolicy?: "allow" | "deny" | null;
		groupActivation?: "mention" | "always" | null;
		execHost?: string | null;
		execSecurity?: string | null;
		execAsk?: string | null;
		execNode?: string | null;
		model?: string | null;
	}): Promise<unknown> {
		return this.request("sessions.patch", params);
	}

	sessionsReset(params: { key: string }): Promise<unknown> {
		return this.request("sessions.reset", params);
	}

	sessionsDelete(params: { key: string }): Promise<unknown> {
		return this.request("sessions.delete", params);
	}

	sessionsResolve(params: {
		key?: string;
		label?: string;
		spawnedBy?: string;
		agentId?: string;
	}): Promise<unknown> {
		return this.request("sessions.resolve", params);
	}

	chatSend(params: {
		text: string;
		files?: Array<{ mediaType: string; url: string; filename?: string }>;
		webSearchEnabled?: boolean;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	}): Promise<{ messages?: string[] }> {
		return this.request("chat.send", params);
	}

	async chatStream(params: {
		text: string;
		files?: Array<{ mediaType: string; url: string; filename?: string }>;
		webSearchEnabled?: boolean;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	}): Promise<{ stream: ReadableStream<unknown>; streamId: string }> {
		const payload = (await this.request("chat.send", {
			...params,
			stream: true,
		})) as { streamId?: string };
		const streamId = payload?.streamId;
		if (!streamId) {
			throw new Error("chat_stream_unavailable");
		}
		const stream = new ReadableStream<unknown>({
			start: (controller) => {
				this.streams.set(streamId, controller);
			},
			cancel: () => {
				this.streams.delete(streamId);
			},
		});
		return { stream, streamId };
	}

	abortChat(streamId: string): Promise<{ ok: boolean }> {
		return this.request("chat.abort", { streamId });
	}

	skillsStatus(): Promise<SkillStatusReport> {
		return this.request("skills.status");
	}

	skillsUpdate(params: {
		skillKey: string;
		enabled?: boolean;
		env?: Record<string, string>;
	}): Promise<{ ok: boolean; skillKey: string }> {
		return this.request("skills.update", params);
	}

	skillsInstall(params: {
		name: string;
		installId: string;
		timeoutMs?: number;
	}): Promise<{ ok?: boolean; message?: string }> {
		return this.request("skills.install", params);
	}

	close() {
		this.ws?.close();
		this.ws = null;
	}
}
