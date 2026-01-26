import type { DurableObjectState, DurableObject } from "@cloudflare/workers-types";

export type SessionKind = "direct" | "group" | "global" | "unknown";

export type SessionEntry = {
	key: string;
	kind: SessionKind;
	label?: string;
	displayName?: string;
	agentId?: string;
	spawnedBy?: string;
	surface?: string;
	subject?: string;
	room?: string;
	space?: string;
	lastChannel?: string;
	lastTo?: string;
	deliveryContext?: Record<string, unknown>;
	updatedAt: number | null;
	sessionId?: string;
	systemSent?: boolean;
	abortedLastRun?: boolean;
	thinkingLevel?: string;
	verboseLevel?: string;
	reasoningLevel?: string;
	elevatedLevel?: string;
	responseUsage?: "off" | "tokens" | "full" | "on";
	sendPolicy?: "allow" | "deny";
	groupActivation?: "mention" | "always";
	execHost?: string;
	execSecurity?: string;
	execAsk?: string;
	execNode?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	model?: string;
	modelProvider?: string;
	contextTokens?: number;
};

export type SessionsListResult = {
	ts: number;
	path: string;
	count: number;
	defaults: { model: string | null; contextTokens: number | null };
	sessions: SessionEntry[];
};

type StoredSessions = {
	sessions: Record<string, SessionEntry>;
};

const STORE_KEY = "sessions";
const STORE_PATH = "do://sessions";

function now() {
	return Date.now();
}

function buildKeyIndex(sessions: Record<string, SessionEntry>) {
	const labels = new Map<string, string>();
	for (const [key, entry] of Object.entries(sessions)) {
		if (entry.label) labels.set(entry.label, key);
		if (entry.displayName) labels.set(entry.displayName, key);
	}
	return labels;
}

function normalizeSessionKind(kind?: string): SessionKind {
	if (kind === "direct" || kind === "group" || kind === "global") return kind;
	return "unknown";
}

export class SessionsDO implements DurableObject {
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
			case "/patch":
				return this.patch(body as Record<string, unknown>);
			case "/reset":
				return this.reset(body as Record<string, unknown>);
			case "/delete":
				return this.remove(body as Record<string, unknown>);
			case "/resolve":
				return this.resolve(body as Record<string, unknown>);
			case "/touch":
				return this.touch(body as Record<string, unknown>);
			default:
				return new Response("Not Found", { status: 404 });
		}
	}

	private async load(): Promise<StoredSessions> {
		const stored = (await this.state.storage.get<StoredSessions>(STORE_KEY)) ?? {
			sessions: {},
		};
		return {
			sessions: stored.sessions ?? {},
		};
	}

	private async save(next: StoredSessions) {
		await this.state.storage.put(STORE_KEY, next);
	}

	private async list(params: Record<string, unknown>) {
		const state = await this.load();
		const activeMinutes = Number.parseFloat(
			String(params.activeMinutes ?? ""),
		);
		const limit = Number.parseInt(String(params.limit ?? ""), 10);
		const includeGlobal = params.includeGlobal !== false;
		const includeUnknown = params.includeUnknown !== false;
		const labelFilter =
			typeof params.label === "string" ? params.label.trim() : "";
		const spawnedByFilter =
			typeof params.spawnedBy === "string" ? params.spawnedBy.trim() : "";
		const agentIdFilter =
			typeof params.agentId === "string" ? params.agentId.trim() : "";
		const cutoff = Number.isFinite(activeMinutes)
			? now() - activeMinutes * 60_000
			: null;
		let entries = Object.values(state.sessions);
		if (!includeGlobal) {
			entries = entries.filter((entry) => entry.kind !== "global");
		}
		if (!includeUnknown) {
			entries = entries.filter((entry) => entry.kind !== "unknown");
		}
		if (labelFilter) {
			entries = entries.filter(
				(entry) => entry.label === labelFilter || entry.displayName === labelFilter,
			);
		}
		if (spawnedByFilter) {
			entries = entries.filter((entry) => entry.spawnedBy === spawnedByFilter);
		}
		if (agentIdFilter) {
			entries = entries.filter((entry) => entry.agentId === agentIdFilter);
		}
		if (cutoff !== null) {
			entries = entries.filter(
				(entry) => entry.updatedAt && entry.updatedAt >= cutoff,
			);
		}
		entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		const sliced = Number.isFinite(limit) && limit > 0 ? entries.slice(0, limit) : entries;
		const result: SessionsListResult = {
			ts: now(),
			path: STORE_PATH,
			count: entries.length,
			defaults: { model: null, contextTokens: null },
			sessions: sliced,
		};
		return Response.json(result);
	}

	private async patch(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		if (!key) return new Response("key required", { status: 400 });
		const state = await this.load();
		const entry = state.sessions[key] ?? {
			key,
			kind: "unknown",
			updatedAt: now(),
		};
		const label =
			params.label === null
				? undefined
				: typeof params.label === "string"
					? params.label.trim() || undefined
					: entry.label;
		const spawnedBy =
			params.spawnedBy === null
				? undefined
				: typeof params.spawnedBy === "string"
					? params.spawnedBy.trim() || undefined
					: entry.spawnedBy;
		const agentId =
			params.agentId === null
				? undefined
				: typeof params.agentId === "string"
					? params.agentId.trim() || undefined
					: entry.agentId;
		const responseUsage =
			params.responseUsage === null
				? undefined
				: typeof params.responseUsage === "string"
					? (params.responseUsage as SessionEntry["responseUsage"])
					: entry.responseUsage;
		const sendPolicy =
			params.sendPolicy === null
				? undefined
				: params.sendPolicy === "allow" || params.sendPolicy === "deny"
					? (params.sendPolicy as SessionEntry["sendPolicy"])
					: entry.sendPolicy;
		const groupActivation =
			params.groupActivation === null
				? undefined
				: params.groupActivation === "mention" || params.groupActivation === "always"
					? (params.groupActivation as SessionEntry["groupActivation"])
					: entry.groupActivation;
		const execHost =
			params.execHost === null
				? undefined
				: typeof params.execHost === "string"
					? params.execHost.trim() || undefined
					: entry.execHost;
		const execSecurity =
			params.execSecurity === null
				? undefined
				: typeof params.execSecurity === "string"
					? params.execSecurity.trim() || undefined
					: entry.execSecurity;
		const execAsk =
			params.execAsk === null
				? undefined
				: typeof params.execAsk === "string"
					? params.execAsk.trim() || undefined
					: entry.execAsk;
		const execNode =
			params.execNode === null
				? undefined
				: typeof params.execNode === "string"
					? params.execNode.trim() || undefined
					: entry.execNode;
		const model =
			params.model === null
				? undefined
				: typeof params.model === "string"
					? params.model.trim() || undefined
					: entry.model;
		const next: SessionEntry = {
			...entry,
			label,
			spawnedBy,
			agentId,
			thinkingLevel:
				typeof params.thinkingLevel === "string"
					? params.thinkingLevel
					: entry.thinkingLevel,
			verboseLevel:
				typeof params.verboseLevel === "string"
					? params.verboseLevel
					: entry.verboseLevel,
			reasoningLevel:
				typeof params.reasoningLevel === "string"
					? params.reasoningLevel
					: entry.reasoningLevel,
			elevatedLevel:
				typeof params.elevatedLevel === "string"
					? params.elevatedLevel
					: entry.elevatedLevel,
			responseUsage,
			sendPolicy,
			groupActivation,
			execHost,
			execSecurity,
			execAsk,
			execNode,
			model,
			updatedAt: now(),
		};
		state.sessions[key] = next;
		await this.save(state);
		return Response.json({ ok: true, path: STORE_PATH, key, entry: next });
	}

	private async reset(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		if (!key) return new Response("key required", { status: 400 });
		const state = await this.load();
		const entry = state.sessions[key];
		const next: SessionEntry = {
			...(entry ?? { key, kind: "unknown" }),
			sessionId: crypto.randomUUID(),
			updatedAt: now(),
			systemSent: false,
			abortedLastRun: false,
		};
		state.sessions[key] = next;
		await this.save(state);
		return Response.json({ ok: true, key, entry: next });
	}

	private async remove(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		if (!key) return new Response("key required", { status: 400 });
		const state = await this.load();
		delete state.sessions[key];
		await this.save(state);
		return Response.json({ ok: true, deleted: true });
	}

	private async resolve(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		const label = String(params.label ?? "").trim();
		const spawnedBy =
			typeof params.spawnedBy === "string" ? params.spawnedBy.trim() : "";
		const agentId =
			typeof params.agentId === "string" ? params.agentId.trim() : "";
		const state = await this.load();
		if (key && state.sessions[key]) {
			return Response.json({ ok: true, key });
		}
		if (label) {
			const candidates = Object.values(state.sessions).filter((entry) => {
				if (entry.label !== label && entry.displayName !== label) return false;
				if (spawnedBy && entry.spawnedBy !== spawnedBy) return false;
				if (agentId && entry.agentId !== agentId) return false;
				return true;
			});
			if (candidates.length > 0) {
				const sorted = candidates.sort(
					(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
				);
				return Response.json({ ok: true, key: sorted[0]?.key });
			}
			const map = buildKeyIndex(state.sessions);
			const resolved = map.get(label);
			if (resolved) return Response.json({ ok: true, key: resolved });
		}
		return new Response("not_found", { status: 404 });
	}

	private async touch(params: Record<string, unknown>) {
		const key = String(params.key ?? "").trim();
		if (!key) return new Response("key required", { status: 400 });
		const state = await this.load();
		const entry = state.sessions[key] ?? {
			key,
			kind: normalizeSessionKind(String(params.kind ?? "unknown")),
			updatedAt: now(),
		};
		const next: SessionEntry = {
			...entry,
			kind: normalizeSessionKind(String(params.kind ?? entry.kind)),
			surface:
				typeof params.surface === "string" && params.surface.trim()
					? params.surface.trim()
					: entry.surface,
			subject:
				typeof params.subject === "string" && params.subject.trim()
					? params.subject.trim()
					: entry.subject,
			room:
				typeof params.room === "string" && params.room.trim()
					? params.room.trim()
					: entry.room,
			space:
				typeof params.space === "string" && params.space.trim()
					? params.space.trim()
					: entry.space,
			label:
				typeof params.label === "string" && params.label.trim()
					? params.label.trim()
					: entry.label,
			displayName:
				typeof params.displayName === "string" && params.displayName.trim()
					? params.displayName.trim()
					: entry.displayName,
			agentId:
				typeof params.agentId === "string" && params.agentId.trim()
					? params.agentId.trim()
					: entry.agentId,
			spawnedBy:
				typeof params.spawnedBy === "string" && params.spawnedBy.trim()
					? params.spawnedBy.trim()
					: entry.spawnedBy,
			lastChannel:
				typeof params.lastChannel === "string" && params.lastChannel.trim()
					? params.lastChannel.trim()
					: entry.lastChannel,
			lastTo:
				typeof params.lastTo === "string" && params.lastTo.trim()
					? params.lastTo.trim()
					: entry.lastTo,
			updatedAt: now(),
			inputTokens:
				typeof params.inputTokens === "number" ? params.inputTokens : entry.inputTokens,
			outputTokens:
				typeof params.outputTokens === "number"
					? params.outputTokens
					: entry.outputTokens,
			totalTokens:
				typeof params.totalTokens === "number" ? params.totalTokens : entry.totalTokens,
			model:
				typeof params.model === "string" ? params.model : entry.model,
			modelProvider:
				typeof params.modelProvider === "string"
					? params.modelProvider
					: entry.modelProvider,
			contextTokens:
				typeof params.contextTokens === "number"
					? params.contextTokens
					: entry.contextTokens,
			sessionId:
				typeof params.sessionId === "string" && params.sessionId.trim()
					? params.sessionId.trim()
					: entry.sessionId,
			responseUsage:
				typeof params.responseUsage === "string"
					? (params.responseUsage as SessionEntry["responseUsage"])
					: entry.responseUsage,
			sendPolicy:
				params.sendPolicy === "allow" || params.sendPolicy === "deny"
					? (params.sendPolicy as SessionEntry["sendPolicy"])
					: entry.sendPolicy,
			groupActivation:
				params.groupActivation === "mention" || params.groupActivation === "always"
					? (params.groupActivation as SessionEntry["groupActivation"])
					: entry.groupActivation,
		};
		state.sessions[key] = next;
		await this.save(state);
		return Response.json({ ok: true });
	}
}
