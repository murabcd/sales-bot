import { openai } from "@ai-sdk/openai";
import {
	type LanguageModel,
	stepCountIs,
	ToolLoopAgent,
	type ToolSet,
	tool,
} from "ai";
import { regex } from "arkregex";
import { z } from "zod";
import { buildSystemPrompt } from "../prompts/system-prompt.js";

export type OrchestrationAgentId =
	| "tracker"
	| "jira"
	| "posthog"
	| "web"
	| "memory";

export type OrchestrationPlan = {
	agents: Array<{ id: OrchestrationAgentId; reason: string }>;
};

export type OrchestrationSummary = {
	agentId: OrchestrationAgentId;
	text: string;
	toolUsage: string[];
};

export type OrchestrationResult = {
	summaries: OrchestrationSummary[];
	toolUsage: string[];
};

export type OrchestrationContext = {
	prompt: string;
	modelId: string;
	toolsByAgent: Record<OrchestrationAgentId, ToolSet>;
	isGroupChat: boolean;
	log: (event: Record<string, unknown>) => void;
	promptMode?: "full" | "minimal" | "none";
	promptContext?: {
		modelRef: string;
		modelName: string;
		reasoning: string;
		globalSoul?: string;
	};
	getModel?: (provider: "openai" | "google", modelId: string) => LanguageModel;
	defaultSubagentModelProvider?: "openai" | "google";
	defaultSubagentModelId?: string;
	allowAgents?: OrchestrationAgentId[];
	denyAgents?: OrchestrationAgentId[];
	parallelism?: number;
	agentOverrides?: Record<
		string,
		{
			modelId?: string;
			provider?: "openai" | "google";
			maxSteps?: number;
			timeoutMs?: number;
			instructions?: string;
		}
	>;
	defaultMaxSteps?: number;
	defaultTimeoutMs?: number;
	budgets?: Partial<
		Record<
			OrchestrationAgentId,
			{
				maxSteps?: number;
				maxToolCalls?: number;
				timeoutMs?: number;
			}
		>
	>;
	hooks?: {
		beforeToolCall?: (event: {
			agentId: OrchestrationAgentId;
			toolName: string;
			input: unknown;
		}) => { allow?: boolean; reason?: string } | undefined;
		afterToolCall?: (event: {
			agentId: OrchestrationAgentId;
			toolName: string;
			durationMs: number;
			error?: string;
		}) => void;
	};
};

const ROUTER_SCHEMA = z.object({
	agents: z
		.array(
			z.object({
				id: z.enum(["tracker", "jira", "posthog", "web", "memory"]),
				reason: z.string().min(1),
			}),
		)
		.optional(),
});

const ISSUE_KEY_RE = regex("\\b(?<prefix>[A-Z]{2,10})-(?<num>\\d+)\\b");

function buildSubagentSystemPrompt(params: {
	promptContext?: OrchestrationContext["promptContext"];
	toolNames: string[];
	baseInstruction: string;
}): string {
	const promptContext = params.promptContext;
	if (!promptContext) return params.baseInstruction;
	const base = buildSystemPrompt({
		modelRef: promptContext.modelRef,
		modelName: promptContext.modelName,
		reasoning: promptContext.reasoning,
	});
	const globalSoul = promptContext.globalSoul?.trim();
	const soulBlock = globalSoul
		? ["SOUL (global):", globalSoul, ""].join("\n")
		: "";
	const toolLines =
		params.toolNames.length > 0 ? params.toolNames.join("\n") : "(none)";
	const toolsBlock = ["Available tools:", toolLines, ""].join("\n");
	return [base, soulBlock, toolsBlock, params.baseInstruction]
		.filter((line) => line?.trim())
		.join("\n\n");
}

function buildRouterTool() {
	return tool({
		description:
			"Decide which specialized agents should run for this request. Return a list of agents with reasons. Use tracker/jira for issue data, posthog for analytics, web for external info, memory for user context. In group chats, avoid web and memory.",
		inputSchema: z.object({
			prompt: z.string(),
			isGroupChat: z.boolean(),
		}),
		execute: async ({ prompt, isGroupChat }) => {
			const agents: Array<{ id: OrchestrationAgentId; reason: string }> = [];
			const lower = prompt.toLowerCase();
			const issueKeyMatch = prompt.match(ISSUE_KEY_RE);
			const issuePrefix =
				issueKeyMatch?.groups?.prefix ?? issueKeyMatch?.[1] ?? "";
			const hasIssueKey = Boolean(issueKeyMatch);
			const wantsAnalytics =
				lower.includes("posthog") ||
				lower.includes("аналит") ||
				lower.includes("конвер") ||
				lower.includes("фаннел") ||
				lower.includes("воронк") ||
				lower.includes("событ") ||
				lower.includes("insight") ||
				lower.includes("hogql");
			const wantsWeb =
				lower.includes("в интернете") ||
				lower.includes("в сети") ||
				lower.includes("найди") ||
				lower.includes("посмотри") ||
				lower.includes("search") ||
				lower.includes("news");
			const wantsSprint =
				lower.includes("sprint") ||
				lower.includes("спринт") ||
				lower.includes("board") ||
				lower.includes("доска") ||
				lower.includes("backlog");

			if (issuePrefix === "FL") {
				agents.push({ id: "jira", reason: "FL issue key" });
			} else if (issuePrefix === "PROJ") {
				agents.push({ id: "tracker", reason: "PROJ issue key" });
			} else if (hasIssueKey || lower.includes("tracker")) {
				agents.push({
					id: "tracker",
					reason: "Issue key or Tracker reference",
				});
			}
			if (
				lower.includes("jira") ||
				lower.includes("джира") ||
				lower.includes("джайра") ||
				wantsSprint
			) {
				agents.push({ id: "jira", reason: "Jira reference" });
			}
			if (wantsAnalytics) {
				agents.push({ id: "posthog", reason: "Analytics intent" });
			}
			if (wantsWeb && !isGroupChat) {
				agents.push({ id: "web", reason: "External info requested" });
			}
			if (
				!isGroupChat &&
				(lower.includes("помни") || lower.includes("история"))
			) {
				agents.push({ id: "memory", reason: "User memory context" });
			}

			return { agents };
		},
	});
}

export function applyRoutingPolicy(
	plan: OrchestrationPlan,
	options: {
		allowAgents?: OrchestrationAgentId[];
		denyAgents?: OrchestrationAgentId[];
	},
): OrchestrationPlan {
	const allow = options.allowAgents?.length
		? new Set(options.allowAgents)
		: null;
	const deny = new Set(options.denyAgents ?? []);
	if (!allow && deny.size === 0) return plan;
	return {
		agents: plan.agents.filter((agent) => {
			if (deny.has(agent.id)) return false;
			if (allow && !allow.has(agent.id)) return false;
			return true;
		}),
	};
}

export function wrapToolsForAgent(
	agentId: OrchestrationAgentId,
	tools: ToolSet,
	options?: {
		maxToolCalls?: number;
		hooks?: OrchestrationContext["hooks"];
	},
): ToolSet {
	let toolCalls = 0;
	const wrapped: ToolSet = {};
	for (const [name, toolDef] of Object.entries(tools)) {
		const execute = toolDef?.execute;
		if (!execute) {
			wrapped[name] = toolDef;
			continue;
		}
		wrapped[name] = {
			...toolDef,
			execute: async (input: unknown) => {
				if (options?.maxToolCalls && toolCalls >= options.maxToolCalls) {
					throw new Error("TOOL_CALL_BUDGET_EXCEEDED");
				}
				toolCalls += 1;
				const guard = options?.hooks?.beforeToolCall?.({
					agentId,
					toolName: name,
					input,
				});
				if (guard && guard.allow === false) {
					throw new Error(guard.reason ?? "TOOL_CALL_BLOCKED");
				}
				const startedAt = Date.now();
				try {
					const result = await execute(input as never, {
						toolCallId: `orch:${agentId}:${name}`,
						messages: [],
					});
					options?.hooks?.afterToolCall?.({
						agentId,
						toolName: name,
						durationMs: Date.now() - startedAt,
					});
					return result;
				} catch (error) {
					options?.hooks?.afterToolCall?.({
						agentId,
						toolName: name,
						durationMs: Date.now() - startedAt,
						error: String(error),
					});
					throw error;
				}
			},
		};
	}
	return wrapped;
}

async function withTimeout<T>(
	task: Promise<T>,
	timeoutMs?: number,
): Promise<T> {
	if (!timeoutMs || timeoutMs <= 0) return task;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error("ORCHESTRATION_TIMEOUT"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([task, timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

export async function routeRequest(
	prompt: string,
	modelId: string,
	isGroupChat: boolean,
): Promise<OrchestrationPlan> {
	const routerAgent = new ToolLoopAgent({
		model: openai(modelId),
		tools: { route: buildRouterTool() },
		stopWhen: stepCountIs(1),
	});
	const routerPrompt = `User prompt: ${prompt}\nGroup chat: ${
		isGroupChat ? "yes" : "no"
	}`;
	const result = await routerAgent.generate({
		prompt: routerPrompt,
	});
	const toolResults = (result as { toolResults?: Array<{ result?: unknown }> })
		.toolResults;
	const payload = toolResults?.[0]?.result;
	const parsed = ROUTER_SCHEMA.safeParse(payload);
	if (!parsed.success || !parsed.data?.agents) return { agents: [] };
	return { agents: parsed.data.agents };
}

export async function runOrchestration(
	plan: OrchestrationPlan,
	context: OrchestrationContext,
): Promise<OrchestrationResult> {
	const filteredPlan = applyRoutingPolicy(plan, {
		allowAgents: context.allowAgents,
		denyAgents: context.denyAgents,
	});
	const summaries: OrchestrationSummary[] = [];
	const toolUsage: string[] = [];
	const orchestrationId = `${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const start = Date.now();

	const parallelism =
		context.parallelism && context.parallelism > 0 ? context.parallelism : 1;
	const pending = filteredPlan.agents.map((entry, index) => ({
		entry,
		index,
	}));
	const results: Array<OrchestrationSummary | null> = new Array(
		filteredPlan.agents.length,
	).fill(null);

	const runAgent = async (
		entry: OrchestrationPlan["agents"][number],
		index: number,
	) => {
		const budget = context.budgets?.[entry.id];
		const override = context.agentOverrides?.[entry.id] ?? {};
		const tools = context.toolsByAgent[entry.id];
		if (!tools || Object.keys(tools).length === 0) return;
		const wrappedTools = wrapToolsForAgent(entry.id, tools, {
			maxToolCalls: budget?.maxToolCalls,
			hooks: context.hooks,
		});
		const instructions =
			override.instructions ??
			`You are the ${entry.id} subagent. Provide a concise summary for the user.`;
		const promptMode = context.promptMode ?? "full";
		const toolNames = Object.keys(tools);
		const resolvedInstructions =
			promptMode === "minimal"
				? buildSubagentSystemPrompt({
						promptContext: context.promptContext,
						toolNames,
						baseInstruction: instructions,
					})
				: instructions;
		const modelId =
			override.modelId ?? context.defaultSubagentModelId ?? context.modelId;
		const maxSteps =
			override.maxSteps ?? budget?.maxSteps ?? context.defaultMaxSteps ?? 3;
		const timeoutMs =
			override.timeoutMs ??
			budget?.timeoutMs ??
			context.defaultTimeoutMs ??
			20_000;
		const provider =
			override.provider ?? context.defaultSubagentModelProvider ?? "openai";
		const modelFactory =
			context.getModel ??
			((prov, id) => (prov === "google" ? openai(id) : openai(id)));
		const agent = new ToolLoopAgent({
			model: modelFactory(provider, modelId),
			instructions: resolvedInstructions,
			tools: wrappedTools,
			stopWhen: stepCountIs(maxSteps),
		});
		try {
			const result = await withTimeout(
				agent.generate({ prompt: context.prompt }),
				timeoutMs,
			);
			const summaryText = result.text?.trim() ?? "";
			const steps = (
				result as {
					steps?: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
				}
			).steps;
			const used = (steps ?? [])
				.flatMap((step) => step.toolCalls ?? [])
				.map((call) => call.toolName)
				.filter((name): name is string => Boolean(name));
			toolUsage.push(...used);
			results[index] = {
				agentId: entry.id,
				text: summaryText,
				toolUsage: used,
			};
		} catch (error) {
			context.log({
				event: "orchestration_subagent_error",
				orchestration_id: orchestrationId,
				agent: entry.id,
				error: String(error),
			});
		}
	};

	const workers = Array.from({ length: parallelism }, async () => {
		while (pending.length > 0) {
			const item = pending.shift();
			if (!item) return;
			await runAgent(item.entry, item.index);
		}
	});

	await Promise.all(workers);
	for (const entry of results) {
		if (entry) summaries.push(entry);
	}

	context.log({
		event: "orchestration",
		orchestration_id: orchestrationId,
		plan: filteredPlan.agents.map((agent) => agent.id),
		parallelism,
		tools: Array.from(new Set(toolUsage)),
		durationMs: Date.now() - start,
	});

	return { summaries, toolUsage: Array.from(new Set(toolUsage)) };
}
