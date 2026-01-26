import type { DurableObject, DurableObjectState } from "@cloudflare/workers-types";

export type ChannelKind = "direct" | "group" | "unknown";

export type ChannelEntry = {
	key: string;
	kind: ChannelKind;
	surface: string;
	chatId: string;
	title?: string;
	label?: string;
	lastSeenAt: number;
	enabled?: boolean;
	requireMention?: boolean;
	allowUserIds?: string[];
	skillsAllowlist?: string[];
	skillsDenylist?: string[];
	systemPrompt?: string;
};

type StoredChannels = {
	channels: Record<string, ChannelEntry>;
};

const STORE_KEY = "channels";

function now() {
	return Date.now();
}

function normalizeKind(kind?: string): ChannelKind {
	if (kind === "direct" || kind === "group") return kind;
	return "unknown";
}

export class ChannelsDO implements DurableObject {
	private state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const body = await request.json();
		switch (url.pathname) {
			case "/list":
				return this.list(body as Record<string, unknown>);
			case "/touch":
				return this.touch(body as Record<string, unknown>);
			case "/patch":
				return this.patch(body as Record<string, unknown>);
			default:
				return new Response("Not Found", { status: 404 });
		}
	}

	private async load(): Promise<StoredChannels> {
		const stored = (await this.state.storage.get<StoredChannels>(STORE_KEY)) ?? {
			channels: {},
		};
		return {
			channels: stored.channels ?? {},
		};
	}

	private async save(next: StoredChannels) {
		await this.state.storage.put(STORE_KEY, next);
	}

	private async list(params: Record<string, unknown>) {
		const includeDisabled = params.includeDisabled !== false;
		const limit = Number.parseInt(String(params.limit ?? ""), 10);
		const state = await this.load();
		let entries = Object.values(state.channels);
		if (!includeDisabled) {
			entries = entries.filter((entry) => entry.enabled !== false);
		}
		entries.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
		const sliced = Number.isFinite(limit) && limit > 0 ? entries.slice(0, limit) : entries;
		return Response.json({ entries: sliced });
	}

	private async touch(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		const chatId = String(params.chatId ?? "").trim();
		const surface = String(params.surface ?? "").trim();
		if (!key || !chatId || !surface) {
			return new Response("key, chatId, surface required", { status: 400 });
		}
		const state = await this.load();
		const entry = state.channels[key] ?? {
			key,
			kind: normalizeKind(String(params.kind ?? "unknown")),
			surface,
			chatId,
			lastSeenAt: now(),
			enabled: true,
		};
		const next: ChannelEntry = {
			...entry,
			kind: normalizeKind(String(params.kind ?? entry.kind)),
			title:
				typeof params.title === "string" && params.title.trim()
					? params.title.trim()
					: entry.title,
			label:
				typeof params.label === "string" && params.label.trim()
					? params.label.trim()
					: entry.label,
			lastSeenAt: now(),
		};
		state.channels[key] = next;
		await this.save(state);
		return Response.json({ ok: true, entry: next });
	}

	private async patch(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		if (!key) return new Response("key required", { status: 400 });
		const state = await this.load();
		const entry = state.channels[key];
		if (!entry) return new Response("not_found", { status: 404 });
		const enabled =
			typeof params.enabled === "boolean" ? params.enabled : entry.enabled;
		const label =
			params.label === null
				? undefined
				: typeof params.label === "string"
					? params.label.trim() || undefined
					: entry.label;
		const requireMention =
			typeof params.requireMention === "boolean"
				? params.requireMention
				: entry.requireMention;
		const allowUserIds = Array.isArray(params.allowUserIds)
			? params.allowUserIds
					.map((value) => String(value).trim())
					.filter((value) => value.length > 0)
			: entry.allowUserIds;
		const skillsAllowlist = Array.isArray(params.skillsAllowlist)
			? params.skillsAllowlist
					.map((value) => String(value).trim())
					.filter((value) => value.length > 0)
			: entry.skillsAllowlist;
		const skillsDenylist = Array.isArray(params.skillsDenylist)
			? params.skillsDenylist
					.map((value) => String(value).trim())
					.filter((value) => value.length > 0)
			: entry.skillsDenylist;
		const systemPrompt =
			params.systemPrompt === null
				? undefined
				: typeof params.systemPrompt === "string"
					? params.systemPrompt.trim() || undefined
					: entry.systemPrompt;
		const next: ChannelEntry = {
			...entry,
			enabled,
			label,
			requireMention,
			allowUserIds,
			skillsAllowlist,
			skillsDenylist,
			systemPrompt,
		};
		state.channels[key] = next;
		await this.save(state);
		return Response.json({ ok: true, entry: next });
	}
}
