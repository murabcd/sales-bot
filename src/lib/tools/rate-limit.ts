import { normalizeToolName } from "./registry.js";

export type ToolRateLimitRule = {
	tool: string;
	max: number;
	windowSeconds: number;
};

export type ToolRateLimitResult = {
	allowed: boolean;
	remaining: number;
	resetMs: number;
};

export function parseToolRateLimits(raw: string): ToolRateLimitRule[] {
	if (!raw.trim()) return [];
	const entries = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const rules: ToolRateLimitRule[] = [];
	for (const entry of entries) {
		const [toolPart, limitPart] = entry.split(":").map((part) => part.trim());
		if (!toolPart || !limitPart) continue;
		const [maxRaw, windowRaw] = limitPart.split("/").map((part) => part.trim());
		const max = Number.parseInt(maxRaw ?? "", 10);
		const windowSeconds = Number.parseInt(windowRaw ?? "", 10);
		if (!Number.isFinite(max) || !Number.isFinite(windowSeconds)) continue;
		if (max <= 0 || windowSeconds <= 0) continue;
		rules.push({
			tool: normalizeToolName(toolPart),
			max,
			windowSeconds,
		});
	}
	return rules;
}

export function createToolRateLimiter(rules: ToolRateLimitRule[]) {
	const buckets = new Map<string, number[]>();
	const normalizedRules = rules.map((rule) => ({
		...rule,
		tool: normalizeToolName(rule.tool),
	}));

	const findRule = (tool: string) => {
		const normalized = normalizeToolName(tool);
		return (
			normalizedRules.find((rule) => rule.tool === normalized) ??
			normalizedRules.find((rule) => rule.tool === "*")
		);
	};

	const prune = (timestamps: number[], windowMs: number, now: number) => {
		let idx = 0;
		while (idx < timestamps.length && now - timestamps[idx] >= windowMs) {
			idx += 1;
		}
		if (idx > 0) timestamps.splice(0, idx);
	};

	const check = (
		tool: string,
		chatId?: string,
		userId?: string,
	): ToolRateLimitResult => {
		const rule = findRule(tool);
		if (!rule) {
			return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetMs: 0 };
		}
		const key = `${rule.tool}:${chatId ?? "global"}:${userId ?? "global"}`;
		const now = Date.now();
		const windowMs = rule.windowSeconds * 1000;
		const timestamps = buckets.get(key) ?? [];
		prune(timestamps, windowMs, now);
		if (timestamps.length >= rule.max) {
			const resetMs = Math.max(0, timestamps[0] + windowMs - now);
			buckets.set(key, timestamps);
			return { allowed: false, remaining: 0, resetMs };
		}
		timestamps.push(now);
		buckets.set(key, timestamps);
		const remaining = Math.max(0, rule.max - timestamps.length);
		const resetMs = timestamps.length > 0 ? timestamps[0] + windowMs - now : 0;
		return { allowed: true, remaining, resetMs };
	};

	return { check };
}
