import type { Update } from "grammy/types";

export type GatewayRoute = "admin" | "telegram" | "other";

export type GatewayRequestContext = {
	request: Request;
	env: Record<string, string | undefined>;
	url: URL;
	path: string;
	route: GatewayRoute;
	update?: Update;
};

export type GatewayDecision = { allow?: boolean; reason?: string };

export type GatewayHooks = {
	beforeRequest?: (ctx: GatewayRequestContext) => GatewayDecision | undefined;
	afterRequest?: (
		ctx: GatewayRequestContext & {
			durationMs: number;
			response?: Response;
			error?: string;
		},
	) => void;
};

export type GatewayPlugin = {
	id: string;
	hooks: GatewayHooks;
};

const BUILTIN_PLUGINS: Record<string, () => GatewayPlugin> = {
	logger: () => ({
		id: "logger",
		hooks: {
			beforeRequest: (ctx) => {
				console.log(
					JSON.stringify({
						event: "gateway_request",
						route: ctx.route,
						path: ctx.path,
						method: ctx.request.method,
					}),
				);
				return undefined;
			},
			afterRequest: (ctx) => {
				console.log(
					JSON.stringify({
						event: "gateway_response",
						route: ctx.route,
						path: ctx.path,
						method: ctx.request.method,
						duration_ms: ctx.durationMs,
						status: ctx.response?.status ?? 0,
						error: ctx.error,
					}),
				);
			},
		},
	}),
};

function parseList(raw: string | undefined) {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function loadGatewayPlugins(env: Record<string, string | undefined>) {
	const allow = new Set(parseList(env.GATEWAY_PLUGINS_ALLOWLIST));
	const deny = new Set(parseList(env.GATEWAY_PLUGINS_DENYLIST));
	const requested = parseList(env.GATEWAY_PLUGINS);
	const plugins: GatewayPlugin[] = [];

	for (const idRaw of requested) {
		const id = idRaw.toLowerCase();
		if (deny.has(id)) continue;
		if (allow.size > 0 && !allow.has(id)) continue;
		const factory = BUILTIN_PLUGINS[id];
		if (!factory) continue;
		plugins.push(factory());
	}

	return plugins.flatMap((plugin) => plugin.hooks);
}
