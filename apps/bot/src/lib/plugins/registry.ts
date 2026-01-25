import fs from "node:fs";
import path from "node:path";
import type { ToolSet } from "ai";
import { normalizeToolName } from "../tools/registry.js";

export type PluginToolRegistration = {
	name: string;
	description?: string;
	tool: ToolSet[string];
	origin?: string;
};

export type PluginToolHookContext = {
	toolName: string;
	toolCallId?: string;
	input: unknown;
	chatId?: string;
	userId?: string;
};

export type PluginHooks = {
	beforeToolCall?: (
		ctx: PluginToolHookContext,
	) => { allow?: boolean; reason?: string } | undefined;
	afterToolCall?: (
		ctx: PluginToolHookContext & { durationMs: number; error?: string },
	) => void;
};

export type PluginApi = {
	pluginId: string;
	registerTool: (tool: PluginToolRegistration) => void;
	registerHooks: (hooks: PluginHooks) => void;
	logger?: {
		info: (event: Record<string, unknown>) => void;
		error: (event: Record<string, unknown>) => void;
	};
};

type LoadedPlugin = {
	id: string;
	tools: PluginToolRegistration[];
	hooks: PluginHooks[];
};

function parseList(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function resolvePluginId(modulePath: string, mod: Record<string, unknown>) {
	const id =
		typeof mod.pluginId === "string"
			? mod.pluginId
			: typeof mod.id === "string"
				? mod.id
				: typeof mod.default === "object" &&
						mod.default &&
						typeof (mod.default as { id?: string }).id === "string"
					? (mod.default as { id: string }).id
					: path.basename(modulePath, path.extname(modulePath));
	return id;
}

export class PluginRegistry {
	private plugins: LoadedPlugin[] = [];
	private allow: Set<string> | null;
	private deny: Set<string>;
	private logger?: PluginApi["logger"];

	constructor(options?: {
		allow?: string[];
		deny?: string[];
		logger?: PluginApi["logger"];
	}) {
		this.allow = options?.allow?.length
			? new Set(options.allow.map((id) => id.toLowerCase()))
			: null;
		this.deny = new Set((options?.deny ?? []).map((id) => id.toLowerCase()));
		this.logger = options?.logger;
	}

	async load(paths: string[]) {
		for (const rawPath of paths) {
			const modulePath = path.resolve(rawPath);
			if (!fs.existsSync(modulePath)) {
				this.logger?.error?.({
					event: "plugin_load_error",
					path: modulePath,
					error: "file_not_found",
				});
				continue;
			}
			try {
				const mod = (await import(pathToFileUrl(modulePath))) as Record<
					string,
					unknown
				>;
				const pluginId = resolvePluginId(modulePath, mod);
				const normalizedId = pluginId.toLowerCase();
				if (this.deny.has(normalizedId)) {
					this.logger?.info?.({
						event: "plugin_skipped",
						pluginId,
						reason: "denylist",
					});
					continue;
				}
				if (this.allow && !this.allow.has(normalizedId)) {
					this.logger?.info?.({
						event: "plugin_skipped",
						pluginId,
						reason: "allowlist",
					});
					continue;
				}
				const tools: PluginToolRegistration[] = [];
				const hooks: PluginHooks[] = [];
				const api: PluginApi = {
					pluginId,
					registerTool: (tool) => tools.push(tool),
					registerHooks: (hook) => hooks.push(hook),
					logger: this.logger,
				};
				const entry = mod.default;
				if (typeof entry === "function") {
					await entry(api);
				} else {
					this.logger?.error?.({
						event: "plugin_load_error",
						pluginId,
						error: "missing_default_export",
					});
					continue;
				}
				this.plugins.push({ id: pluginId, tools, hooks });
				this.logger?.info?.({
					event: "plugin_loaded",
					pluginId,
					tools: tools.map((tool) => tool.name),
				});
			} catch (error) {
				this.logger?.error?.({
					event: "plugin_load_error",
					path: modulePath,
					error: String(error),
				});
			}
		}
	}

	getTools() {
		return this.plugins.flatMap((plugin) =>
			plugin.tools.map((tool) => ({
				...tool,
				name: normalizeToolName(tool.name),
				origin: tool.origin ?? plugin.id,
			})),
		);
	}

	getHooks(): PluginHooks[] {
		return this.plugins.flatMap((plugin) => plugin.hooks);
	}
}

function pathToFileUrl(filePath: string) {
	const resolved = path.resolve(filePath);
	const url = new URL(`file://${resolved}`);
	return url.toString();
}

export function parsePluginPaths(raw: string): string[] {
	return parseList(raw);
}

export function parsePluginAllowDeny(raw: string): string[] {
	return parseList(raw).map((entry) => entry.toLowerCase());
}
