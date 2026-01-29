import {
	type OrchestrationAgentId,
	type OrchestrationPlan,
	routeRequest,
} from "../agents/orchestrator.js";
import type { BotContext } from "../bot/types.js";

type Logger = {
	info: (payload: Record<string, unknown>) => void;
};

export type OrchestrationConfig = {
	allowAgentsRaw: string;
	denyAgentsRaw: string;
	subagentMaxSteps: number;
	subagentMaxToolCalls: number;
	subagentTimeoutMs: number;
	parallelism: number;
	agentConfigOverrides: string;
	agentDefaultMaxSteps: number;
	agentDefaultTimeoutMs: number;
	logger: Logger;
	isGroupChat: (ctx: BotContext) => boolean;
	getActiveModelId: () => string;
};

export type OrchestrationHelpers = {
	buildOrchestrationPlan: (
		prompt: string,
		ctx: BotContext,
	) => Promise<OrchestrationPlan>;
	buildOrchestrationSummary: (result: {
		summaries: Array<{ agentId: string; text: string; toolUsage: string[] }>;
	}) => string;
	mergeHistoryBlocks: (primary?: string, extra?: string) => string;
	resolveOrchestrationPolicy: (ctx: BotContext) => {
		allowAgents?: OrchestrationAgentId[];
		denyAgents: OrchestrationAgentId[];
		budgets: Record<
			OrchestrationAgentId,
			{
				maxSteps?: number;
				maxToolCalls?: number;
				timeoutMs?: number;
			}
		>;
		parallelism: number;
		agentOverrides: Record<
			string,
			{
				modelId?: string;
				provider?: "openai" | "google";
				maxSteps?: number;
				timeoutMs?: number;
				instructions?: string;
			}
		>;
		defaultMaxSteps: number;
		defaultTimeoutMs: number;
		hooks: {
			beforeToolCall: (params: {
				agentId: OrchestrationAgentId;
				toolName: string;
				input: unknown;
			}) => { allow?: boolean; reason?: string } | undefined;
			afterToolCall: (params: {
				agentId: OrchestrationAgentId;
				toolName: string;
				durationMs: number;
				error?: string;
			}) => void;
		};
	};
};

export function createOrchestrationHelpers(
	config: OrchestrationConfig,
): OrchestrationHelpers {
	function parseOrchestrationAgentList(raw: string): OrchestrationAgentId[] {
		if (!raw.trim()) return [];
		const allowed = new Set<OrchestrationAgentId>([
			"tracker",
			"jira",
			"posthog",
			"web",
			"memory",
		]);
		return raw
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter((value): value is OrchestrationAgentId =>
				allowed.has(value as OrchestrationAgentId),
			);
	}

	function buildOrchestrationBudgets() {
		const maxSteps = Number.isFinite(config.subagentMaxSteps)
			? config.subagentMaxSteps
			: undefined;
		const maxToolCalls = Number.isFinite(config.subagentMaxToolCalls)
			? config.subagentMaxToolCalls
			: undefined;
		const timeoutMs = Number.isFinite(config.subagentTimeoutMs)
			? config.subagentTimeoutMs
			: undefined;
		return {
			tracker: { maxSteps, maxToolCalls, timeoutMs },
			jira: { maxSteps, maxToolCalls, timeoutMs },
			posthog: { maxSteps, maxToolCalls, timeoutMs },
			web: { maxSteps, maxToolCalls, timeoutMs },
			memory: { maxSteps, maxToolCalls, timeoutMs },
		} satisfies Record<
			OrchestrationAgentId,
			{ maxSteps?: number; maxToolCalls?: number; timeoutMs?: number }
		>;
	}

	function parseAgentOverrides(raw: string) {
		if (!raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw) as Record<
				string,
				{
					modelId?: string;
					provider?: "openai" | "google";
					maxSteps?: number;
					timeoutMs?: number;
					instructions?: string;
				}
			>;
			return parsed ?? {};
		} catch {
			return {};
		}
	}

	function buildOrchestrationSummary(result: {
		summaries: Array<{ agentId: string; text: string; toolUsage: string[] }>;
	}) {
		if (result.summaries.length === 0) return "";
		return [
			"Orchestration summary (internal; do not quote to user):",
			...result.summaries.map((summary) => {
				const toolLine = summary.toolUsage.length
					? `Tools: ${summary.toolUsage.join(", ")}`
					: "Tools: none";
				return [
					`[${summary.agentId}]`,
					summary.text || "(no summary)",
					toolLine,
				].join("\n");
			}),
			"",
		].join("\n\n");
	}

	function mergeHistoryBlocks(primary?: string, extra?: string) {
		if (primary && extra) return `${primary}\n\n${extra}`;
		return primary ?? extra ?? "";
	}

	function resolveOrchestrationPolicy(ctx: BotContext) {
		const allowAgents = parseOrchestrationAgentList(config.allowAgentsRaw);
		const denyAgents = new Set(
			parseOrchestrationAgentList(config.denyAgentsRaw),
		);
		if (config.isGroupChat(ctx)) {
			denyAgents.add("web");
			denyAgents.add("memory");
		}
		const blockedTools = new Set<string>();
		if (config.isGroupChat(ctx)) {
			blockedTools.add("web_search");
			blockedTools.add("searchMemories");
			blockedTools.add("addMemory");
		}
		return {
			allowAgents: allowAgents.length > 0 ? allowAgents : undefined,
			denyAgents: Array.from(denyAgents),
			budgets: buildOrchestrationBudgets(),
			parallelism:
				Number.isFinite(config.parallelism) && config.parallelism > 0
					? config.parallelism
					: 1,
			agentOverrides: parseAgentOverrides(config.agentConfigOverrides),
			defaultMaxSteps:
				Number.isFinite(config.agentDefaultMaxSteps) &&
				config.agentDefaultMaxSteps > 0
					? config.agentDefaultMaxSteps
					: 6,
			defaultTimeoutMs:
				Number.isFinite(config.agentDefaultTimeoutMs) &&
				config.agentDefaultTimeoutMs > 0
					? config.agentDefaultTimeoutMs
					: 20_000,
			hooks: {
				beforeToolCall: ({
					agentId,
					toolName,
					input,
				}: {
					agentId: OrchestrationAgentId;
					toolName: string;
					input: unknown;
				}) => {
					if (blockedTools.has(toolName)) {
						config.logger.info({
							event: "orchestration_tool_blocked",
							agent: agentId,
							tool: toolName,
						});
						return { allow: false, reason: "tool disabled in group chat" };
					}
					config.logger.info({
						event: "orchestration_tool_call",
						agent: agentId,
						tool: toolName,
						input,
					});
					return undefined;
				},
				afterToolCall: ({
					agentId,
					toolName,
					durationMs,
					error,
				}: {
					agentId: OrchestrationAgentId;
					toolName: string;
					durationMs: number;
					error?: string;
				}) => {
					config.logger.info({
						event: "orchestration_tool_result",
						agent: agentId,
						tool: toolName,
						durationMs,
						error,
					});
				},
			},
		};
	}

	function buildOrchestrationPlan(
		prompt: string,
		ctx: BotContext,
	): Promise<OrchestrationPlan> {
		return routeRequest(
			prompt,
			config.getActiveModelId(),
			config.isGroupChat(ctx),
		);
	}

	return {
		buildOrchestrationPlan,
		buildOrchestrationSummary,
		mergeHistoryBlocks,
		resolveOrchestrationPolicy,
	};
}
