import fs from "node:fs";
import path from "node:path";
import { normalizeToolName } from "./registry.js";

export type ApprovalStore = {
	isApproved: (chatId: string, toolName: string) => boolean;
	approve: (chatId: string, toolName: string) => void;
	clear: (chatId: string, toolName?: string) => void;
	_dump?: () => ApprovalSnapshot;
};

export function parseApprovalList(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => normalizeToolName(entry));
}

type ApprovalSnapshot = Record<string, Record<string, number>>;

function loadApprovals(filePath: string): ApprovalSnapshot {
	try {
		if (!fs.existsSync(filePath)) return {};
		const raw = fs.readFileSync(filePath, "utf-8");
		if (!raw.trim()) return {};
		const parsed = JSON.parse(raw) as ApprovalSnapshot;
		return parsed ?? {};
	} catch {
		return {};
	}
}

function saveApprovals(filePath: string, data: ApprovalSnapshot) {
	try {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
	} catch {
		// ignore persistence errors
	}
}

function toSnapshot(store: Map<string, Map<string, number>>): ApprovalSnapshot {
	const snapshot: ApprovalSnapshot = {};
	for (const [chatId, byTool] of store.entries()) {
		snapshot[chatId] = {};
		for (const [tool, expiresAt] of byTool.entries()) {
			snapshot[chatId][tool] = expiresAt;
		}
	}
	return snapshot;
}

function fromSnapshot(
	snapshot: ApprovalSnapshot,
): Map<string, Map<string, number>> {
	const store = new Map<string, Map<string, number>>();
	for (const [chatId, tools] of Object.entries(snapshot)) {
		const byTool = new Map<string, number>();
		for (const [tool, expiresAt] of Object.entries(tools ?? {})) {
			if (typeof expiresAt === "number") byTool.set(tool, expiresAt);
		}
		if (byTool.size > 0) store.set(chatId, byTool);
	}
	return store;
}

export function listApprovals(
	store: ApprovalStore,
	chatId: string,
): Array<{ tool: string; expiresAt: number }> {
	const results: Array<{ tool: string; expiresAt: number }> = [];
	if (!chatId) return results;
	const internal = (store as { _dump?: () => ApprovalSnapshot })._dump?.();
	if (!internal) return results;
	const byTool = internal[chatId] ?? {};
	for (const [tool, expiresAt] of Object.entries(byTool)) {
		if (typeof expiresAt === "number") {
			results.push({ tool, expiresAt });
		}
	}
	results.sort((a, b) => a.expiresAt - b.expiresAt);
	return results;
}

export function createApprovalStore(
	ttlMs = 10 * 60 * 1000,
	options?: { filePath?: string },
): ApprovalStore {
	const filePath = options?.filePath;
	const store = filePath
		? fromSnapshot(loadApprovals(filePath))
		: new Map<string, Map<string, number>>();

	const isApproved = (chatId: string, toolName: string) => {
		if (!chatId) return false;
		const toolKey = normalizeToolName(toolName);
		const byTool = store.get(chatId);
		if (!byTool) return false;
		const expiresAt = byTool.get(toolKey);
		if (!expiresAt) return false;
		if (Date.now() > expiresAt) {
			byTool.delete(toolKey);
			if (byTool.size === 0) store.delete(chatId);
			if (filePath) saveApprovals(filePath, toSnapshot(store));
			return false;
		}
		return true;
	};

	const approve = (chatId: string, toolName: string) => {
		if (!chatId) return;
		const toolKey = normalizeToolName(toolName);
		const byTool = store.get(chatId) ?? new Map<string, number>();
		byTool.set(toolKey, Date.now() + ttlMs);
		store.set(chatId, byTool);
		if (filePath) saveApprovals(filePath, toSnapshot(store));
	};

	const clear = (chatId: string, toolName?: string) => {
		if (!chatId) return;
		if (!toolName) {
			store.delete(chatId);
			if (filePath) saveApprovals(filePath, toSnapshot(store));
			return;
		}
		const toolKey = normalizeToolName(toolName);
		const byTool = store.get(chatId);
		if (!byTool) return;
		byTool.delete(toolKey);
		if (byTool.size === 0) store.delete(chatId);
		if (filePath) saveApprovals(filePath, toSnapshot(store));
	};

	return {
		isApproved,
		approve,
		clear,
		_dump: () => toSnapshot(store),
	} as ApprovalStore;
}
