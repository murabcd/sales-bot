import { openai } from "@ai-sdk/openai";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { PostHogAgentToolkit } from "@posthog/agent-toolkit/integrations/ai-sdk";
import { supermemoryTools } from "@supermemory/tools/ai-sdk";
import {
	type ModelMessage,
	stepCountIs,
	ToolLoopAgent,
	type ToolSet,
	type TypedToolCall,
	type TypedToolResult,
	tool,
	experimental_transcribe as transcribe,
} from "ai";
import {
	API_CONSTANTS,
	Bot,
	type CallbackQueryContext,
	type Context,
	InlineKeyboard,
} from "grammy";
import type { Update } from "grammy/types";
import { z } from "zod";
import {
	createIssueAgent,
	createMultiIssueAgent,
} from "./lib/agents/issue-agent.js";
import {
	type OrchestrationAgentId,
	type OrchestrationPlan,
	routeRequest,
	runOrchestration,
} from "./lib/agents/orchestrator.js";
import {
	buildJiraTools,
	buildMemoryTools as buildMemorySubagentTools,
	buildPosthogTools,
	buildTrackerTools,
	buildWebTools,
} from "./lib/agents/subagents/index.js";
import { type CandidateIssue, getChatState } from "./lib/context/chat-state.js";
import {
	appendHistoryMessage,
	clearHistoryMessages,
	formatHistoryForPrompt,
	loadHistoryMessages,
	setSupermemoryConfig,
} from "./lib/context/session-history.js";
import {
	buildJiraJql,
	extractJiraText,
	type JiraIssue,
	normalizeJiraIssue,
} from "./lib/jira.js";
import { createLogger } from "./lib/logger.js";
import {
	PluginRegistry,
	parsePluginAllowDeny,
	parsePluginPaths,
} from "./lib/plugins/registry.js";
import {
	filterPosthogTools,
	POSTHOG_READONLY_TOOL_NAMES,
} from "./lib/posthog-tools.js";
import { buildAgentInstructions } from "./lib/prompts/agent-instructions.js";
import { isBotMentionedMessage } from "./lib/telegram-mentions.js";
import {
	expandTermVariants,
	extractIssueKeysFromText,
	extractKeywords,
	normalizeForMatch,
} from "./lib/text/normalize.js";
import { createToolStatusHandler } from "./lib/tool-status.js";
import {
	isToolAllowedForSender,
	parseSenderToolAccess,
} from "./lib/tools/access.js";
import {
	createApprovalStore,
	listApprovals,
	parseApprovalList,
} from "./lib/tools/approvals.js";
import { wrapToolMapWithHooks } from "./lib/tools/hooks.js";
import {
	filterToolMapByPolicy,
	filterToolMetasByPolicy,
	isToolAllowed,
	mergeToolPolicies,
	parseToolPolicyVariants,
} from "./lib/tools/policy.js";
import {
	createToolRateLimiter,
	parseToolRateLimits,
} from "./lib/tools/rate-limit.js";
import {
	createToolRegistry,
	normalizeToolName,
	type ToolConflict,
	type ToolMeta,
} from "./lib/tools/registry.js";
import { sanitizeToolCallIdsForTranscript } from "./lib/tools/tool-call-id.js";
import { repairToolUseResultPairing } from "./lib/tools/transcript-repair.js";
import {
	type ModelsFile,
	normalizeModelRef,
	selectModel,
} from "./models-core.js";
import { type RuntimeSkill, resolveToolRef } from "./skills-core.js";

export type BotEnv = Record<string, string | undefined>;

export type CreateBotOptions = {
	env: BotEnv;
	modelsConfig: ModelsFile;
	runtimeSkills?: RuntimeSkill[];
	getUptimeSeconds?: () => number;
	onDebugLog?: (line: string) => void;
};

export async function createBot(options: CreateBotOptions) {
	const env = options.env;
	const BOT_TOKEN = env.BOT_TOKEN;
	const TRACKER_TOKEN = env.TRACKER_TOKEN;
	const TRACKER_CLOUD_ORG_ID = env.TRACKER_CLOUD_ORG_ID;
	const TRACKER_ORG_ID = env.TRACKER_ORG_ID ?? "";
	const JIRA_BASE_URL = env.JIRA_BASE_URL ?? "";
	const JIRA_EMAIL = env.JIRA_EMAIL ?? "";
	const JIRA_API_TOKEN = env.JIRA_API_TOKEN ?? "";
	const JIRA_PROJECT_KEY = env.JIRA_PROJECT_KEY ?? "FL";
	const JIRA_BOARD_ID = Number.parseInt(env.JIRA_BOARD_ID ?? "", 10);
	const POSTHOG_PERSONAL_API_KEY = env.POSTHOG_PERSONAL_API_KEY ?? "";
	const POSTHOG_API_BASE_URL =
		env.POSTHOG_API_BASE_URL ?? "https://eu.posthog.com";
	const OPENAI_API_KEY = env.OPENAI_API_KEY;
	const OPENAI_MODEL = env.OPENAI_MODEL ?? "";
	const ALLOWED_TG_IDS = env.ALLOWED_TG_IDS ?? "";
	const DEFAULT_TRACKER_QUEUE = env.DEFAULT_TRACKER_QUEUE ?? "PROJ";
	const DEFAULT_ISSUE_PREFIX =
		env.DEFAULT_ISSUE_PREFIX ?? DEFAULT_TRACKER_QUEUE;
	const DEBUG_LOGS = env.DEBUG_LOGS === "1";
	const TRACKER_API_BASE_URL =
		env.TRACKER_API_BASE_URL ?? "https://api.tracker.yandex.net";
	const SUPERMEMORY_API_KEY = env.SUPERMEMORY_API_KEY ?? "";
	const SUPERMEMORY_PROJECT_ID = env.SUPERMEMORY_PROJECT_ID ?? "";
	const SUPERMEMORY_TAG_PREFIX = env.SUPERMEMORY_TAG_PREFIX ?? "telegram:user:";
	const HISTORY_MAX_MESSAGES = Number.parseInt(
		env.HISTORY_MAX_MESSAGES ?? "20",
		10,
	);
	const COMMENTS_CACHE_TTL_MS = Number.parseInt(
		env.COMMENTS_CACHE_TTL_MS ?? "300000",
		10,
	);
	const COMMENTS_CACHE_MAX = Number.parseInt(
		env.COMMENTS_CACHE_MAX ?? "500",
		10,
	);
	const COMMENTS_FETCH_CONCURRENCY = Number.parseInt(
		env.COMMENTS_FETCH_CONCURRENCY ?? "4",
		10,
	);
	const COMMENTS_FETCH_BUDGET_MS = Number.parseInt(
		env.COMMENTS_FETCH_BUDGET_MS ?? "2500",
		10,
	);

	const commentsCache = new Map<
		string,
		{ at: number; value: { text: string; truncated: boolean } }
	>();
	const jiraCommentsCache = new Map<
		string,
		{ at: number; value: { text: string; truncated: boolean } }
	>();

	const TELEGRAM_TIMEOUT_SECONDS = Number.parseInt(
		env.TELEGRAM_TIMEOUT_SECONDS ?? "60",
		10,
	);
	const TELEGRAM_TEXT_CHUNK_LIMIT = Number.parseInt(
		env.TELEGRAM_TEXT_CHUNK_LIMIT ?? "4000",
		10,
	);
	const ALLOWED_TG_GROUPS = env.ALLOWED_TG_GROUPS ?? "";
	const TELEGRAM_GROUP_REQUIRE_MENTION =
		env.TELEGRAM_GROUP_REQUIRE_MENTION !== "0";
	const WEB_SEARCH_ENABLED = env.WEB_SEARCH_ENABLED === "1";
	const WEB_SEARCH_CONTEXT_SIZE = env.WEB_SEARCH_CONTEXT_SIZE ?? "low";
	const TOOL_RATE_LIMITS = env.TOOL_RATE_LIMITS ?? "";
	const TOOL_APPROVAL_REQUIRED = env.TOOL_APPROVAL_REQUIRED ?? "";
	const TOOL_APPROVAL_TTL_MS = Number.parseInt(
		env.TOOL_APPROVAL_TTL_MS ?? "600000",
		10,
	);
	const TOOL_APPROVAL_STORE_PATH =
		env.TOOL_APPROVAL_STORE_PATH ?? "data/approvals/approvals.json";
	const PLUGINS_PATHS = env.PLUGINS_PATHS ?? "";
	const PLUGINS_ALLOWLIST = env.PLUGINS_ALLOWLIST ?? "";
	const PLUGINS_DENYLIST = env.PLUGINS_DENYLIST ?? "";
	const TOOL_ALLOWLIST_USER_IDS = env.TOOL_ALLOWLIST_USER_IDS ?? "";
	const TOOL_DENYLIST_USER_IDS = env.TOOL_DENYLIST_USER_IDS ?? "";
	const TOOL_ALLOWLIST_USER_TOOLS = env.TOOL_ALLOWLIST_USER_TOOLS ?? "";
	const TOOL_DENYLIST_USER_TOOLS = env.TOOL_DENYLIST_USER_TOOLS ?? "";
	const TOOL_ALLOWLIST_CHAT_TOOLS = env.TOOL_ALLOWLIST_CHAT_TOOLS ?? "";
	const TOOL_DENYLIST_CHAT_TOOLS = env.TOOL_DENYLIST_CHAT_TOOLS ?? "";
	const ORCHESTRATION_ALLOW_AGENTS = env.ORCHESTRATION_ALLOW_AGENTS ?? "";
	const ORCHESTRATION_DENY_AGENTS = env.ORCHESTRATION_DENY_AGENTS ?? "";
	const ORCHESTRATION_SUBAGENT_MAX_STEPS = Number.parseInt(
		env.ORCHESTRATION_SUBAGENT_MAX_STEPS ?? "3",
		10,
	);
	const ORCHESTRATION_SUBAGENT_MAX_TOOL_CALLS = Number.parseInt(
		env.ORCHESTRATION_SUBAGENT_MAX_TOOL_CALLS ?? "4",
		10,
	);
	const ORCHESTRATION_SUBAGENT_TIMEOUT_MS = Number.parseInt(
		env.ORCHESTRATION_SUBAGENT_TIMEOUT_MS ?? "20000",
		10,
	);
	const ORCHESTRATION_PARALLELISM = Number.parseInt(
		env.ORCHESTRATION_PARALLELISM ?? "2",
		10,
	);
	const AGENT_DEFAULT_MAX_STEPS = Number.parseInt(
		env.AGENT_DEFAULT_MAX_STEPS ?? "6",
		10,
	);
	const AGENT_DEFAULT_TIMEOUT_MS = Number.parseInt(
		env.AGENT_DEFAULT_TIMEOUT_MS ?? "20000",
		10,
	);
	const AGENT_CONFIG_OVERRIDES = env.AGENT_CONFIG_OVERRIDES ?? "";
	const SERVICE_NAME = env.SERVICE_NAME ?? "omni";
	const RELEASE_VERSION = env.RELEASE_VERSION ?? env.APP_VERSION ?? undefined;
	const toolPolicies = parseToolPolicyVariants(env);
	const toolPolicy = toolPolicies.base;
	const toolPolicyDm = toolPolicies.dm;
	const toolPolicyGroup = toolPolicies.group;
	const toolRateLimiter = createToolRateLimiter(
		parseToolRateLimits(TOOL_RATE_LIMITS),
	);
	const approvalRequired = new Set(parseApprovalList(TOOL_APPROVAL_REQUIRED));
	const approvalStore = createApprovalStore(
		Number.isFinite(TOOL_APPROVAL_TTL_MS) && TOOL_APPROVAL_TTL_MS > 0
			? TOOL_APPROVAL_TTL_MS
			: 10 * 60 * 1000,
		{ filePath: TOOL_APPROVAL_STORE_PATH },
	);
	const senderToolAccess = parseSenderToolAccess({
		allowUserIds: TOOL_ALLOWLIST_USER_IDS,
		denyUserIds: TOOL_DENYLIST_USER_IDS,
		allowUserTools: TOOL_ALLOWLIST_USER_TOOLS,
		denyUserTools: TOOL_DENYLIST_USER_TOOLS,
		allowChatTools: TOOL_ALLOWLIST_CHAT_TOOLS,
		denyChatTools: TOOL_DENYLIST_CHAT_TOOLS,
	});

	const posthogToolkit = POSTHOG_PERSONAL_API_KEY
		? new PostHogAgentToolkit({
				posthogPersonalApiKey: POSTHOG_PERSONAL_API_KEY,
				posthogApiBaseUrl: POSTHOG_API_BASE_URL,
			})
		: null;
	let posthogToolsPromise: Promise<ToolSet> | null = null;
	const COMMIT_HASH = env.COMMIT_HASH ?? env.GIT_COMMIT ?? undefined;
	const REGION = env.REGION ?? undefined;
	const INSTANCE_ID = env.INSTANCE_ID ?? undefined;
	const logger = createLogger({
		service: SERVICE_NAME,
		version: RELEASE_VERSION,
		commit_hash: COMMIT_HASH,
		region: REGION,
		instance_id: INSTANCE_ID,
	});

	const pluginRegistry = new PluginRegistry({
		allow: parsePluginAllowDeny(PLUGINS_ALLOWLIST),
		deny: parsePluginAllowDeny(PLUGINS_DENYLIST),
		logger: logger,
	});

	await pluginRegistry.load(parsePluginPaths(PLUGINS_PATHS));

	if (!BOT_TOKEN) throw new Error("BOT_TOKEN is unset");
	if (!TRACKER_TOKEN) throw new Error("TRACKER_TOKEN is unset");
	if (!TRACKER_CLOUD_ORG_ID && !TRACKER_ORG_ID) {
		throw new Error("TRACKER_CLOUD_ORG_ID or TRACKER_ORG_ID is unset");
	}
	if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is unset");
	if (!ALLOWED_TG_IDS.trim()) {
		throw new Error("ALLOWED_TG_IDS must be set for production use");
	}

	setSupermemoryConfig({
		apiKey: SUPERMEMORY_API_KEY,
		projectId: SUPERMEMORY_PROJECT_ID || undefined,
		tagPrefix: SUPERMEMORY_TAG_PREFIX,
	});

	const bot = new Bot<BotContext>(BOT_TOKEN, {
		client: {
			timeoutSeconds: Number.isFinite(TELEGRAM_TIMEOUT_SECONDS)
				? TELEGRAM_TIMEOUT_SECONDS
				: 60,
		},
	});

	const modelsConfig = options.modelsConfig;
	let selectedModel: ReturnType<typeof selectModel>;
	try {
		selectedModel = selectModel(modelsConfig, OPENAI_MODEL);
	} catch (error) {
		console.warn(
			`[models] Unknown OPENAI_MODEL "${OPENAI_MODEL}", falling back to primary.`,
			error,
		);
		selectedModel = selectModel(modelsConfig, null);
	}
	let activeModelRef = selectedModel.ref;
	let activeModelConfig = selectedModel.config;
	let activeModelFallbacks = selectedModel.fallbacks;
	let activeReasoningOverride: string | null = null;
	function resolveReasoning(): string {
		return activeReasoningOverride ?? activeModelConfig.reasoning ?? "standard";
	}

	async function getPosthogTools(): Promise<ToolSet> {
		if (!posthogToolkit) return {};
		if (!posthogToolsPromise) {
			posthogToolsPromise = (async () => {
				const tools = (await posthogToolkit.getTools()) as unknown as ToolSet;
				return filterPosthogTools(tools);
			})();
		}
		return posthogToolsPromise;
	}

	const runtimeSkills = options.runtimeSkills ?? [];
	const SUPPORTED_TRACKER_TOOLS = new Set([
		"issues_find",
		"issue_get",
		"issue_get_comments",
		"issue_get_url",
	]);
	const filteredRuntimeSkills = runtimeSkills.filter((skill) => {
		const { server, tool } = resolveToolRef(skill.tool);
		return server === "yandex-tracker" && SUPPORTED_TRACKER_TOOLS.has(tool);
	});
	if (filteredRuntimeSkills.length !== runtimeSkills.length) {
		console.warn(
			`[skills] Filtered runtime skills: ${filteredRuntimeSkills.length}/${runtimeSkills.length} supported.`,
		);
	}

	const toolConflictLogger = (event: {
		event: "tool_conflict";
		name: string;
		normalizedName: string;
		source: string;
		origin?: string;
		existingSource: string;
		existingOrigin?: string;
		reason: "duplicate-name";
	}) => {
		logger.error(event);
	};

	const buildToolInventory = (): {
		agentTools: ToolMeta[];
		commandTools: ToolMeta[];
		allTools: ToolMeta[];
		conflicts: ToolConflict[];
		suppressedByPolicy: string[];
	} => {
		const registry = createToolRegistry({ logger: toolConflictLogger });
		const agentTools: ToolMeta[] = [];
		const commandTools: ToolMeta[] = [];

		const register = (tool: ToolMeta, target: ToolMeta[]) => {
			const res = registry.register(tool);
			if (!res.ok) return;
			target.push(tool);
		};

		for (const pluginTool of pluginRegistry.getTools()) {
			register(
				{
					name: pluginTool.name,
					description: pluginTool.description ?? "Plugin tool",
					source: "plugin",
					origin: pluginTool.origin,
				},
				agentTools,
			);
		}

		register(
			{
				name: "tracker_search",
				description: `Search Yandex Tracker issues in queue ${DEFAULT_TRACKER_QUEUE} using keywords from the question.`,
				source: "tracker",
				origin: "core",
			},
			agentTools,
		);

		if (WEB_SEARCH_ENABLED) {
			register(
				{
					name: "web_search",
					description:
						"Search the web for up-to-date information (OpenAI web_search).",
					source: "web",
					origin: "openai",
				},
				agentTools,
			);
		}

		if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
			register(
				{
					name: "jira_search",
					description: `Search Jira issues in project ${JIRA_PROJECT_KEY} using keywords from the question.`,
					source: "tracker",
					origin: "jira",
				},
				agentTools,
			);
			register(
				{
					name: "jira_sprint_issues",
					description: "List Jira issues for a sprint by name or id.",
					source: "tracker",
					origin: "jira",
				},
				agentTools,
			);
			register(
				{
					name: "jira_issues_find",
					description: "Search Jira issues using JQL.",
					source: "command",
					origin: "jira",
				},
				commandTools,
			);
			register(
				{
					name: "jira_issue_get",
					description: "Get Jira issue by key (e.g., FL-123).",
					source: "command",
					origin: "jira",
				},
				commandTools,
			);
			register(
				{
					name: "jira_issue_get_comments",
					description: "Get comments for a Jira issue by key.",
					source: "command",
					origin: "jira",
				},
				commandTools,
			);
		}

		if (POSTHOG_PERSONAL_API_KEY) {
			for (const name of POSTHOG_READONLY_TOOL_NAMES) {
				register(
					{
						name,
						description: "PostHog read-only tool",
						source: "posthog",
						origin: "posthog",
					},
					agentTools,
				);
			}
		}

		if (SUPERMEMORY_API_KEY) {
			register(
				{
					name: "searchMemories",
					description: "Search saved memories (Supermemory).",
					source: "memory",
					origin: "supermemory",
				},
				agentTools,
			);
			register(
				{
					name: "addMemory",
					description: "Store memory (Supermemory).",
					source: "memory",
					origin: "supermemory",
				},
				agentTools,
			);
		}

		register(
			{
				name: "issues_find",
				description: "Search issues using Yandex Tracker query language.",
				source: "command",
				origin: "tracker",
			},
			commandTools,
		);
		register(
			{
				name: "issue_get",
				description: "Get issue by key (e.g., PROJ-123).",
				source: "command",
				origin: "tracker",
			},
			commandTools,
		);
		register(
			{
				name: "issue_get_comments",
				description: "Get comments for an issue by key.",
				source: "command",
				origin: "tracker",
			},
			commandTools,
		);
		register(
			{
				name: "issue_get_url",
				description: "Build public issue URL.",
				source: "command",
				origin: "tracker",
			},
			commandTools,
		);

		const allTools = registry.list();
		const allowed = filterToolMetasByPolicy(allTools, toolPolicy);
		const allowedSet = new Set(
			allowed.map((tool) => normalizeToolName(tool.name)),
		);
		const suppressedByPolicy = allTools
			.filter((tool) => !allowedSet.has(normalizeToolName(tool.name)))
			.map((tool) => tool.name);

		return {
			agentTools: agentTools.filter((tool) =>
				allowedSet.has(normalizeToolName(tool.name)),
			),
			commandTools: commandTools.filter((tool) =>
				allowedSet.has(normalizeToolName(tool.name)),
			),
			allTools: allTools.filter((tool) =>
				allowedSet.has(normalizeToolName(tool.name)),
			),
			conflicts: registry.conflicts(),
			suppressedByPolicy,
		};
	};

	const toolInventory = buildToolInventory();
	const AGENT_TOOL_LIST = toolInventory.agentTools;
	const ALL_TOOL_LIST = toolInventory.allTools;
	const TOOL_CONFLICTS = toolInventory.conflicts;
	const TOOL_SUPPRESSED_BY_POLICY = toolInventory.suppressedByPolicy;
	let lastTrackerCallAt: number | null = null;

	type LogContext = {
		request_id?: string;
		update_id?: number;
		update_type?: string;
		chat_id?: number | string;
		user_id?: number | string;
		username?: string;
		message_type?: "command" | "text" | "voice" | "callback" | "other";
		command?: string;
		command_sub?: string;
		tool?: string;
		model_ref?: string;
		model_id?: string;
		issue_key?: string;
		issue_key_count?: number;
		outcome?: "success" | "error" | "blocked";
		status_code?: number;
		error?: { message: string; type?: string };
	};

	type BotContext = Context & { state: { logContext?: LogContext } };

	function getLogContext(ctx: BotContext) {
		return ctx.state.logContext ?? {};
	}

	function setLogContext(ctx: BotContext, update: Partial<LogContext>) {
		ctx.state.logContext = { ...ctx.state.logContext, ...update };
	}

	function setLogError(ctx: BotContext, error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const type = error instanceof Error ? error.name : undefined;
		setLogContext(ctx, {
			outcome: "error",
			status_code: 500,
			error: { message, type },
		});
	}

	function getUpdateType(update?: Update) {
		if (!update) return "unknown";
		const keys = Object.keys(
			update as unknown as Record<string, unknown>,
		).filter((key) => key !== "update_id");
		return keys[0] ?? "unknown";
	}

	function logDebug(message: string, data?: unknown) {
		if (!DEBUG_LOGS) return;
		const payload = {
			event: "debug",
			message,
			data,
		};
		const line = JSON.stringify(payload);
		logger.info(payload);
		options.onDebugLog?.(line);
	}

	bot.api.config.use(apiThrottler());
	bot.use(
		sequentialize((ctx) => {
			if (ctx.chat?.id) return `telegram:${ctx.chat.id}`;
			if (ctx.from?.id) return `telegram:user:${ctx.from.id}`;
			return "telegram:unknown";
		}),
	);

	bot.use(async (ctx, next) => {
		ctx.state ??= {};
		const startedAt = Date.now();
		const updateId = ctx.update?.update_id;
		const chatId = ctx.chat?.id;
		const userId = ctx.from?.id;
		const username = ctx.from?.username;
		const updateType = getUpdateType(ctx.update);
		const requestId = `tg:${updateId ?? "unknown"}:${chatId ?? userId ?? "unknown"}`;
		setLogContext(ctx, {
			request_id: requestId,
			update_id: updateId,
			chat_id: chatId,
			user_id: userId,
			username,
			update_type: updateType,
		});

		try {
			await next();
			const context = getLogContext(ctx);
			if (!context.outcome) {
				setLogContext(ctx, { outcome: "success" });
			}
		} catch (error) {
			setLogError(ctx, error);
			throw error;
		} finally {
			const durationMs = Date.now() - startedAt;
			const context = getLogContext(ctx);
			const statusCode =
				context.status_code ??
				(context.outcome === "blocked"
					? 403
					: context.outcome === "error"
						? 500
						: 200);
			if (!context.status_code) {
				setLogContext(ctx, { status_code: statusCode });
			}
			const finalContext = getLogContext(ctx);
			const level = finalContext.outcome === "error" ? "error" : "info";
			logger[level]({
				event: "telegram_update",
				...finalContext,
				duration_ms: durationMs,
			});
		}
	});

	const allowedIds = new Set(
		ALLOWED_TG_IDS.split(",")
			.map((value: string) => value.trim())
			.filter((value: string) => value.length > 0),
	);
	const allowedGroups = new Set(
		ALLOWED_TG_GROUPS.split(",")
			.map((value: string) => value.trim())
			.filter((value: string) => value.length > 0),
	);

	bot.use((ctx, next) => {
		if (allowedIds.size === 0) return next();
		const userId = ctx.from?.id?.toString() ?? "";
		if (!allowedIds.has(userId)) {
			setLogContext(ctx, {
				outcome: "blocked",
				status_code: 403,
			});
			return sendText(ctx, "Доступ запрещен.");
		}
		return next();
	});

	function resolveReasoningFor(config: typeof activeModelConfig): string {
		return activeReasoningOverride ?? config.reasoning ?? "standard";
	}

	function isGroupChat(ctx: BotContext) {
		const type = ctx.chat?.type;
		return type === "group" || type === "supergroup";
	}

	function resolveChatToolPolicy(ctx?: BotContext) {
		if (!ctx) return undefined;
		const chatPolicy = isGroupChat(ctx) ? toolPolicyGroup : toolPolicyDm;
		let merged = mergeToolPolicies(toolPolicy, chatPolicy);
		if (isGroupChat(ctx)) {
			merged = mergeToolPolicies(merged, {
				deny: ["group:web", "group:memory"],
			});
		}
		return merged;
	}

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
		const maxSteps = Number.isFinite(ORCHESTRATION_SUBAGENT_MAX_STEPS)
			? ORCHESTRATION_SUBAGENT_MAX_STEPS
			: undefined;
		const maxToolCalls = Number.isFinite(ORCHESTRATION_SUBAGENT_MAX_TOOL_CALLS)
			? ORCHESTRATION_SUBAGENT_MAX_TOOL_CALLS
			: undefined;
		const timeoutMs = Number.isFinite(ORCHESTRATION_SUBAGENT_TIMEOUT_MS)
			? ORCHESTRATION_SUBAGENT_TIMEOUT_MS
			: undefined;
		return {
			tracker: { maxSteps, maxToolCalls, timeoutMs },
			jira: { maxSteps, maxToolCalls, timeoutMs },
			posthog: { maxSteps, maxToolCalls, timeoutMs },
			web: { maxSteps, maxToolCalls, timeoutMs },
			memory: { maxSteps, maxToolCalls, timeoutMs },
		};
	}

	function parseAgentOverrides(raw: string) {
		if (!raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw) as Record<
				string,
				{
					modelId?: string;
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
		const allowAgents = parseOrchestrationAgentList(ORCHESTRATION_ALLOW_AGENTS);
		const denyAgents = new Set(
			parseOrchestrationAgentList(ORCHESTRATION_DENY_AGENTS),
		);
		if (isGroupChat(ctx)) {
			denyAgents.add("web");
			denyAgents.add("memory");
		}
		const blockedTools = new Set<string>();
		if (isGroupChat(ctx)) {
			blockedTools.add("web_search");
			blockedTools.add("searchMemories");
			blockedTools.add("addMemory");
		}
		return {
			allowAgents: allowAgents.length > 0 ? allowAgents : undefined,
			denyAgents: Array.from(denyAgents),
			budgets: buildOrchestrationBudgets(),
			parallelism:
				Number.isFinite(ORCHESTRATION_PARALLELISM) &&
				ORCHESTRATION_PARALLELISM > 0
					? ORCHESTRATION_PARALLELISM
					: 1,
			agentOverrides: parseAgentOverrides(AGENT_CONFIG_OVERRIDES),
			defaultMaxSteps:
				Number.isFinite(AGENT_DEFAULT_MAX_STEPS) && AGENT_DEFAULT_MAX_STEPS > 0
					? AGENT_DEFAULT_MAX_STEPS
					: 6,
			defaultTimeoutMs:
				Number.isFinite(AGENT_DEFAULT_TIMEOUT_MS) &&
				AGENT_DEFAULT_TIMEOUT_MS > 0
					? AGENT_DEFAULT_TIMEOUT_MS
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
						logger.info({
							event: "orchestration_tool_blocked",
							agent: agentId,
							tool: toolName,
						});
						return { allow: false, reason: "tool disabled in group chat" };
					}
					logger.info({
						event: "orchestration_tool_call",
						agent: agentId,
						tool: toolName,
						input,
					});
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
					logger.info({
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
		return routeRequest(prompt, activeModelConfig.id, isGroupChat(ctx));
	}

	function isGroupAllowed(ctx: BotContext) {
		if (!isGroupChat(ctx)) return true;
		if (allowedGroups.size === 0) return true;
		const chatId = ctx.chat?.id?.toString() ?? "";
		return allowedGroups.has(chatId);
	}

	function isBotMentioned(ctx: BotContext) {
		return isBotMentionedMessage(ctx.message, ctx.me);
	}

	function getModelConfig(ref: string) {
		return modelsConfig.models[ref];
	}

	function formatToolResult(result: TrackerToolResult): string {
		if (typeof result === "string") return result;
		if (result === null || result === undefined) return "";
		try {
			return JSON.stringify(result, null, 2);
		} catch {
			return String(result);
		}
	}

	async function getAgentTools() {
		return AGENT_TOOL_LIST;
	}

	async function getCommandTools() {
		return ALL_TOOL_LIST;
	}

	async function createAgentTools(options?: {
		onCandidates?: (candidates: CandidateIssue[]) => void;
		recentCandidates?: CandidateIssue[];
		history?: string;
		chatId?: string;
		ctx?: BotContext;
	}): Promise<ToolSet> {
		const registry = createToolRegistry({ logger: toolConflictLogger });
		const toolMap: ToolSet = {};
		const registerTool = (meta: ToolMeta, toolDef: ToolSet[string]) => {
			const res = registry.register(meta);
			if (!res.ok) return;
			toolMap[meta.name] = toolDef;
		};

		for (const pluginTool of pluginRegistry.getTools()) {
			registerTool(
				{
					name: pluginTool.name,
					description: pluginTool.description ?? "Plugin tool",
					source: "plugin",
					origin: pluginTool.origin,
				},
				pluginTool.tool,
			);
		}

		const memoryTools = buildMemoryTools(options?.chatId);
		for (const [name, toolDef] of Object.entries(memoryTools)) {
			registerTool(
				{
					name,
					description: "Supermemory tool",
					source: "memory",
					origin: "supermemory",
				},
				toolDef as ToolSet[string],
			);
		}

		const webSearchContextSize = resolveWebSearchContextSize(
			WEB_SEARCH_CONTEXT_SIZE.trim().toLowerCase(),
		);
		if (WEB_SEARCH_ENABLED) {
			registerTool(
				{
					name: "web_search",
					description:
						"Search the web for up-to-date information (OpenAI web_search).",
					source: "web",
					origin: "openai",
				},
				openai.tools.webSearch({ searchContextSize: webSearchContextSize }),
			);
		}

		registerTool(
			{
				name: "tracker_search",
				description: `Search Yandex Tracker issues in queue ${DEFAULT_TRACKER_QUEUE} using keywords from the question.`,
				source: "tracker",
				origin: "core",
			},
			tool({
				description: `Search Yandex Tracker issues in queue ${DEFAULT_TRACKER_QUEUE} using keywords from the question.`,
				inputSchema: z.object({
					question: z.string().describe("User question or keywords"),
					queue: z
						.string()
						.optional()
						.describe(`Queue key, defaults to ${DEFAULT_TRACKER_QUEUE}`),
				}),
				execute: async ({ question, queue }) => {
					const startedAt = Date.now();
					const commentStats = { fetched: 0, cacheHits: 0 };
					const queueKey = queue ?? DEFAULT_TRACKER_QUEUE;
					const query = buildIssuesQuery(question, queueKey);
					const payload = {
						query,
						fields: [
							"key",
							"summary",
							"description",
							"created_at",
							"updated_at",
							"status",
							"tags",
							"priority",
							"estimation",
							"spent",
						],
						per_page: 100,
						include_description: true,
					};
					logDebug("tracker_search", payload);
					try {
						const result = await trackerCallTool(
							"issues_find",
							payload,
							30_000,
							options?.ctx,
						);
						const normalized = normalizeIssuesResult(result);
						const keywords = extractKeywords(question, 12).map((item) =>
							item.toLowerCase(),
						);
						const haveKeywords = keywords.length > 0;

						const issues = normalized.issues;
						const ranked = rankIssues(issues, question);
						const top = ranked.slice(0, 20);
						const commentsByIssue: Record<
							string,
							{ text: string; truncated: boolean }
						> = {};
						const commentDeadline = startedAt + COMMENTS_FETCH_BUDGET_MS;
						await fetchCommentsWithBudget(
							top.map((entry) => entry.key ?? ""),
							commentsByIssue,
							commentDeadline,
							commentStats,
							options?.ctx,
						);

						let selected = top;
						if (haveKeywords) {
							const matches = top.filter((entry) => {
								const summary = getIssueField(entry.issue, [
									"summary",
									"title",
								]);
								const description = getIssueField(entry.issue, ["description"]);
								const comments = entry.key
									? (commentsByIssue[entry.key]?.text ?? "")
									: "";
								const haystack = `${summary} ${description} ${comments}`;
								return matchesKeywords(haystack, keywords);
							});
							if (matches.length) {
								selected = matches;
								logDebug("tracker_search filtered", {
									total: top.length,
									matches: matches.length,
								});
							}
						}

						const topCandidates = selected.slice(0, 5).map((entry) => ({
							key: entry.key,
							summary: getIssueField(entry.issue, ["summary", "title"]),
							score: entry.score,
						}));
						const topScore = selected[0]?.score ?? 0;
						const secondScore = selected[1]?.score ?? 0;
						const ambiguous =
							selected.length > 1 &&
							(topScore <= 3 || topScore - secondScore < 3);

						if (options?.onCandidates) {
							options.onCandidates(topCandidates);
						}

						logDebug("tracker_search result", {
							count: issues.length,
							top: selected.map((item) => item.key).filter((key) => key),
							commentsFetched: commentStats.fetched,
							commentsCacheHits: commentStats.cacheHits,
							durationMs: Date.now() - startedAt,
							ambiguous,
						});
						return {
							issues: selected.map((item) => item.issue),
							scores: selected.map((item) => ({
								key: item.key,
								score: item.score,
							})),
							comments: commentsByIssue,
							ambiguous,
							candidates: topCandidates,
						};
					} catch (error) {
						logDebug("tracker_search error", { error: String(error) });
						return { error: String(error) };
					}
				},
			}),
		);

		if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
			registerTool(
				{
					name: "jira_search",
					description: `Search Jira issues in project ${JIRA_PROJECT_KEY} using keywords from the question.`,
					source: "tracker",
					origin: "jira",
				},
				tool({
					description: `Search Jira issues in project ${JIRA_PROJECT_KEY} using keywords from the question.`,
					inputSchema: z.object({
						question: z.string().describe("User question or keywords"),
						project: z
							.string()
							.optional()
							.describe(`Project key, defaults to ${JIRA_PROJECT_KEY}`),
					}),
					execute: async ({ question, project }) => {
						const startedAt = Date.now();
						const commentStats = { fetched: 0, cacheHits: 0 };
						const projectKey = project ?? JIRA_PROJECT_KEY;
						const jql = buildJiraJql(question, projectKey);
						logDebug("jira_search", { jql, project: projectKey });
						try {
							const issues = await jiraIssuesFind({
								jql,
								maxResults: 50,
								fields: ["summary", "description"],
								timeoutMs: 30_000,
							});
							const normalized = issues.map((issue) =>
								normalizeJiraIssue(issue),
							);
							const top = normalized.slice(0, 20);
							const commentsByIssue: Record<
								string,
								{ text: string; truncated: boolean }
							> = {};
							const commentDeadline = startedAt + COMMENTS_FETCH_BUDGET_MS;
							await fetchJiraCommentsWithBudget(
								top.map((entry) => entry.key),
								commentsByIssue,
								commentDeadline,
								commentStats,
							);
							return {
								issues: top.map((entry) => ({
									...entry,
									comments: commentsByIssue[entry.key]?.text ?? "",
									commentsTruncated:
										commentsByIssue[entry.key]?.truncated ?? false,
								})),
								jql,
								comments: commentsByIssue,
							};
						} catch (error) {
							logDebug("jira_search error", { error: String(error) });
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "jira_sprint_issues",
					description: "List Jira issues for a sprint by name or id.",
					source: "tracker",
					origin: "jira",
				},
				tool({
					description: "List Jira issues for a sprint by name or id.",
					inputSchema: z.object({
						sprintName: z.string().optional().describe("Sprint name"),
						sprintId: z.number().optional().describe("Sprint id"),
						boardId: z.number().optional().describe("Jira board id"),
						maxResults: z.number().optional().describe("Max issues"),
					}),
					execute: async ({ sprintName, sprintId, boardId, maxResults }) => {
						const startedAt = Date.now();
						const normalizedBoardId =
							typeof boardId === "number" && boardId > 0 ? boardId : undefined;
						const normalizedSprintId =
							typeof sprintId === "number" && sprintId > 0
								? sprintId
								: undefined;
						const resolvedBoardId =
							normalizedBoardId ??
							(Number.isFinite(JIRA_BOARD_ID) && JIRA_BOARD_ID > 0
								? JIRA_BOARD_ID
								: undefined);
						try {
							if (!normalizedSprintId && !sprintName) {
								throw new Error("missing_sprint");
							}
							if (!resolvedBoardId && !normalizedSprintId) {
								throw new Error("missing_board_id");
							}
							let resolvedSprintId = normalizedSprintId;
							let resolvedSprintName = sprintName;
							if (!resolvedSprintId && sprintName) {
								const sprint = await jiraSprintFindByName(
									resolvedBoardId as number,
									sprintName,
								);
								if (sprint) {
									resolvedSprintId = sprint.id;
									resolvedSprintName = sprint.name;
								}
							}
							let issues: Array<{
								key: string;
								summary: string;
								status: string;
								assignee: string;
								dueDate: string;
								priority: string;
							}> = [];
							if (resolvedSprintId) {
								issues = await jiraSprintIssues(
									resolvedSprintId as number,
									maxResults,
								);
							} else if (sprintName) {
								const safeName = sprintName.replaceAll('"', "");
								const jql = `project = ${JIRA_PROJECT_KEY} AND sprint = "${safeName}" ORDER BY created DESC`;
								const fallback = await jiraIssuesFind({
									jql,
									maxResults: maxResults ?? 200,
									fields: [
										"summary",
										"status",
										"assignee",
										"duedate",
										"priority",
									],
									timeoutMs: 30_000,
								});
								issues = fallback.map((issue) => ({
									key: issue.key ?? "",
									summary:
										typeof issue.fields?.summary === "string"
											? issue.fields.summary
											: "",
									status: issue.fields?.status?.name ?? "",
									assignee: issue.fields?.assignee?.displayName ?? "",
									dueDate: issue.fields?.duedate ?? "",
									priority: issue.fields?.priority?.name ?? "",
								}));
							} else {
								throw new Error("sprint_not_found");
							}
							logJiraAudit(
								options?.ctx,
								"jira_sprint_issues",
								{
									boardId: resolvedBoardId,
									sprintId: resolvedSprintId,
									sprintName: resolvedSprintName,
								},
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return {
								boardId: resolvedBoardId,
								sprintId: resolvedSprintId,
								sprintName: resolvedSprintName,
								issues,
							};
						} catch (error) {
							logJiraAudit(
								options?.ctx,
								"jira_sprint_issues",
								{ boardId: resolvedBoardId, sprintId, sprintName },
								"error",
								String(error),
								Date.now() - startedAt,
							);
							throw error;
						}
					},
				}),
			);

			registerTool(
				{
					name: "jira_issues_find",
					description: "Search Jira issues using JQL.",
					source: "command",
					origin: "jira",
				},
				tool({
					description: "Search Jira issues using JQL.",
					inputSchema: z.object({
						jql: z.string().describe("JQL query"),
						maxResults: z.number().optional().describe("Max results"),
					}),
					execute: async ({ jql, maxResults }) => {
						const startedAt = Date.now();
						try {
							const issues = await jiraIssuesFind({
								jql,
								maxResults,
								fields: ["summary", "description"],
								timeoutMs: 30_000,
							});
							logJiraAudit(
								options?.ctx,
								"jira_issues_find",
								{ jql },
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return issues.map((issue) => normalizeJiraIssue(issue));
						} catch (error) {
							logJiraAudit(
								options?.ctx,
								"jira_issues_find",
								{ jql },
								"error",
								String(error),
								Date.now() - startedAt,
							);
							throw error;
						}
					},
				}),
			);

			registerTool(
				{
					name: "jira_issue_get",
					description: "Get Jira issue by key (e.g., FL-123).",
					source: "command",
					origin: "jira",
				},
				tool({
					description: "Get Jira issue by key.",
					inputSchema: z.object({
						issueKey: z.string().describe("Issue key"),
					}),
					execute: async ({ issueKey }) => {
						const startedAt = Date.now();
						try {
							const issue = await jiraIssueGet(issueKey, 30_000);
							logJiraAudit(
								options?.ctx,
								"jira_issue_get",
								{ issueKey },
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return normalizeJiraIssue(issue);
						} catch (error) {
							logJiraAudit(
								options?.ctx,
								"jira_issue_get",
								{ issueKey },
								"error",
								String(error),
								Date.now() - startedAt,
							);
							throw error;
						}
					},
				}),
			);

			registerTool(
				{
					name: "jira_issue_get_comments",
					description: "Get comments for a Jira issue by key.",
					source: "command",
					origin: "jira",
				},
				tool({
					description: "Get comments for a Jira issue by key.",
					inputSchema: z.object({
						issueKey: z.string().describe("Issue key"),
					}),
					execute: async ({ issueKey }) => {
						const startedAt = Date.now();
						try {
							const comments = await jiraIssueGetComments({ issueKey }, 30_000);
							logJiraAudit(
								options?.ctx,
								"jira_issue_get_comments",
								{ issueKey },
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return comments;
						} catch (error) {
							logJiraAudit(
								options?.ctx,
								"jira_issue_get_comments",
								{ issueKey },
								"error",
								String(error),
								Date.now() - startedAt,
							);
							throw error;
						}
					},
				}),
			);
		}

		if (POSTHOG_PERSONAL_API_KEY) {
			const posthogTools = await getPosthogTools();
			for (const [name, toolDef] of Object.entries(posthogTools)) {
				registerTool(
					{
						name,
						description: "PostHog read-only tool",
						source: "posthog",
						origin: "posthog",
					},
					toolDef,
				);
			}
		}

		const filtered = filterToolMapByPolicy(toolMap, toolPolicy);
		const chatPolicy = resolveChatToolPolicy(options?.ctx);
		const filteredByChat = filterToolMapByPolicy(filtered.tools, chatPolicy);
		const suppressed = [...filtered.suppressed, ...filteredByChat.suppressed];
		if (DEBUG_LOGS && suppressed.length > 0) {
			logDebug("tools suppressed by policy", {
				suppressed,
			});
		}
		const chatId = options?.ctx?.chat?.id?.toString();
		const userId = options?.ctx?.from?.id?.toString();
		const wrapped = wrapToolMapWithHooks(filteredByChat.tools as ToolSet, {
			beforeToolCall: ({ toolName, toolCallId, input }) => {
				for (const hook of pluginRegistry.getHooks()) {
					const decision = hook.beforeToolCall?.({
						toolName,
						toolCallId,
						input,
						chatId,
						userId,
					});
					if (decision && decision.allow === false) {
						return {
							allow: false,
							reason: decision.reason ?? "plugin_blocked",
						};
					}
				}
				if (chatPolicy && !isToolAllowed(toolName, chatPolicy)) {
					logger.info({
						event: "tool_blocked",
						tool: toolName,
						tool_call_id: toolCallId,
						chat_id: chatId,
						user_id: userId,
						reason: "policy",
					});
					return { allow: false, reason: "policy" };
				}
				const senderCheck = isToolAllowedForSender(
					toolName,
					{ userId, chatId },
					senderToolAccess,
				);
				if (!senderCheck.allowed) {
					logger.info({
						event: "tool_blocked",
						tool: toolName,
						tool_call_id: toolCallId,
						chat_id: chatId,
						user_id: userId,
						reason: senderCheck.reason ?? "sender_policy",
					});
					return { allow: false, reason: "sender_policy" };
				}
				const normalized = normalizeToolName(toolName);
				if (
					approvalRequired.size > 0 &&
					approvalRequired.has(normalized) &&
					!approvalStore.isApproved(chatId ?? "", normalized)
				) {
					logger.info({
						event: "tool_approval_required",
						tool: toolName,
						tool_call_id: toolCallId,
						chat_id: chatId,
						user_id: userId,
					});
					return { allow: false, reason: "approval_required" };
				}
				const rate = toolRateLimiter.check(toolName, chatId, userId);
				if (!rate.allowed) {
					logger.info({
						event: "tool_rate_limited",
						tool: toolName,
						tool_call_id: toolCallId,
						chat_id: chatId,
						user_id: userId,
						reset_ms: rate.resetMs,
					});
					return { allow: false, reason: "rate_limited" };
				}
				logger.info({
					event: "tool_call",
					tool: toolName,
					tool_call_id: toolCallId,
					chat_id: chatId,
					user_id: userId,
					input,
				});
			},
			afterToolCall: ({ toolName, toolCallId, durationMs, error }) => {
				logger.info({
					event: "tool_result",
					tool: toolName,
					tool_call_id: toolCallId,
					chat_id: chatId,
					user_id: userId,
					duration_ms: durationMs,
					error,
				});
				for (const hook of pluginRegistry.getHooks()) {
					hook.afterToolCall?.({
						toolName,
						toolCallId,
						input: null,
						chatId,
						userId,
						durationMs,
						error,
					});
				}
			},
		});
		return wrapped;
	}

	type AgentToolSet = Awaited<ReturnType<typeof createAgentTools>>;
	type AgentToolCall = TypedToolCall<AgentToolSet>;
	type AgentToolResult = TypedToolResult<AgentToolSet>;

	function buildMemoryTools(chatId?: string) {
		if (!SUPERMEMORY_API_KEY || !chatId) return {};
		const containerTags = [`${SUPERMEMORY_TAG_PREFIX}${chatId}`];
		const options = SUPERMEMORY_PROJECT_ID
			? { projectId: SUPERMEMORY_PROJECT_ID, containerTags }
			: { containerTags };
		return supermemoryTools(SUPERMEMORY_API_KEY, options);
	}

	function resolveWebSearchContextSize(
		value: string,
	): "low" | "medium" | "high" {
		if (value === "medium" || value === "high") return value;
		return "low";
	}

	async function createAgent(
		question: string,
		modelRef: string,
		modelConfig: typeof activeModelConfig,
		options?: {
			onCandidates?: (candidates: CandidateIssue[]) => void;
			recentCandidates?: CandidateIssue[];
			history?: string;
			chatId?: string;
			userName?: string;
			onToolStep?: (toolNames: string[]) => Promise<void> | void;
			ctx?: BotContext;
		},
	) {
		const tools = await getAgentTools();
		const toolLines = tools
			.map((toolItem) => {
				const desc = toolItem.description ? ` - ${toolItem.description}` : "";
				return `${toolItem.name}${desc}`;
			})
			.join("\n");
		const instructions = buildAgentInstructions({
			question,
			modelRef,
			modelName: modelConfig.label ?? modelConfig.id,
			reasoning: resolveReasoningFor(modelConfig),
			toolLines,
			recentCandidates: options?.recentCandidates,
			history: options?.history,
			userName: options?.userName,
		});
		const agentTools = await createAgentTools(options);
		return new ToolLoopAgent({
			model: openai(modelConfig.id),
			instructions,
			tools: agentTools,
			stopWhen: stepCountIs(6),
			prepareCall: (params) => {
				const messages = params.messages;
				if (!Array.isArray(messages)) return params;
				const sanitized = sanitizeToolCallIdsForTranscript(
					messages as unknown as Array<Record<string, unknown>>,
				);
				const repaired = repairToolUseResultPairing(sanitized);
				if (
					DEBUG_LOGS &&
					(repaired.added.length > 0 ||
						repaired.droppedDuplicateCount > 0 ||
						repaired.droppedOrphanCount > 0 ||
						repaired.moved)
				) {
					logDebug("transcript repair", {
						added: repaired.added.length,
						droppedDuplicate: repaired.droppedDuplicateCount,
						droppedOrphan: repaired.droppedOrphanCount,
						moved: repaired.moved,
					});
				}
				return {
					...params,
					messages: repaired.messages as unknown as ModelMessage[],
				};
			},
			onStepFinish: ({ toolCalls }) => {
				if (!options?.onToolStep) return;
				const names = (toolCalls ?? [])
					.map((call) => call?.toolName)
					.filter((name): name is string => Boolean(name));
				if (names.length > 0) {
					options.onToolStep(names);
				}
			},
		});
	}

	function matchesKeywords(text: string, keywords: string[]): boolean {
		const normalizedText = normalizeForMatch(text);
		return (
			keywords.length === 0 ||
			keywords.some((word) => normalizedText.includes(normalizeForMatch(word)))
		);
	}

	function isSprintQuery(text: string) {
		const lower = text.toLowerCase();
		return (
			lower.includes("sprint") ||
			lower.includes("спринт") ||
			lower.includes("board") ||
			lower.includes("доска") ||
			lower.includes("backlog")
		);
	}

	function extractExplicitIssueKeys(text: string): string[] {
		const matches = text.match(/\b[A-Z]{2,10}-\d+\b/g) ?? [];
		const unique = new Set(matches.map((match) => match.toUpperCase()));
		return Array.from(unique);
	}

	function isJiraIssueKey(key: string) {
		return key.startsWith(`${JIRA_PROJECT_KEY}-`);
	}

	function normalizeSprintName(value: string) {
		return value
			.trim()
			.replaceAll("–", "-")
			.replaceAll("—", "-")
			.replaceAll(/\s+/g, " ")
			.toLowerCase();
	}

	function getCachedComments(
		issueId: string,
	): { text: string; truncated: boolean } | null {
		const cached = commentsCache.get(issueId);
		if (!cached) return null;
		if (Date.now() - cached.at > COMMENTS_CACHE_TTL_MS) {
			commentsCache.delete(issueId);
			return null;
		}
		return cached.value;
	}

	function setCachedComments(
		issueId: string,
		value: { text: string; truncated: boolean },
	) {
		commentsCache.set(issueId, { at: Date.now(), value });
		if (commentsCache.size <= COMMENTS_CACHE_MAX) return;
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of commentsCache.entries()) {
			if (entry.at < oldestAt) {
				oldestAt = entry.at;
				oldestKey = key;
			}
		}
		if (oldestKey) commentsCache.delete(oldestKey);
	}

	async function fetchCommentsWithBudget(
		keys: string[],
		commentsByIssue: Record<string, { text: string; truncated: boolean }>,
		deadlineMs: number,
		stats: { fetched: number; cacheHits: number },
		ctx?: BotContext,
	) {
		if (!keys.length) return;
		let cursor = 0;
		const concurrency = Math.max(1, COMMENTS_FETCH_CONCURRENCY);

		const worker = async () => {
			while (true) {
				if (Date.now() > deadlineMs) return;
				const index = cursor;
				cursor += 1;
				if (index >= keys.length) return;
				const key = keys[index];
				if (!key || commentsByIssue[key]) continue;
				const cached = getCachedComments(key);
				if (cached) {
					stats.cacheHits += 1;
					commentsByIssue[key] = cached;
					continue;
				}
				try {
					const commentResult = await trackerCallTool(
						"issue_get_comments",
						{ issue_id: key },
						30_000,
						ctx,
					);
					stats.fetched += 1;
					const extracted = extractCommentsText(commentResult);
					commentsByIssue[key] = extracted;
					setCachedComments(key, extracted);
				} catch (error) {
					logDebug("issue_get_comments error", {
						key,
						error: String(error),
					});
				}
			}
		};

		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	}

	async function fetchJiraCommentsWithBudget(
		keys: string[],
		commentsByIssue: Record<string, { text: string; truncated: boolean }>,
		deadlineMs: number,
		stats: { fetched: number; cacheHits: number },
	) {
		if (!keys.length) return;
		let cursor = 0;
		const concurrency = Math.max(1, COMMENTS_FETCH_CONCURRENCY);

		const worker = async () => {
			while (true) {
				if (Date.now() > deadlineMs) return;
				const index = cursor;
				cursor += 1;
				if (index >= keys.length) return;
				const key = keys[index];
				if (!key || commentsByIssue[key]) continue;
				const cached = getJiraCachedComments(key);
				if (cached) {
					stats.cacheHits += 1;
					commentsByIssue[key] = cached;
					continue;
				}
				try {
					const commentResult = await jiraIssueGetComments(
						{ issueKey: key },
						30_000,
					);
					stats.fetched += 1;
					commentsByIssue[key] = commentResult;
					setJiraCachedComments(key, commentResult);
				} catch (error) {
					logDebug("jira_issue_get_comments error", {
						key,
						error: String(error),
					});
				}
			}
		};

		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	}

	function normalizeIssuesResult(result: TrackerToolResult): {
		issues: Array<Record<string, unknown>>;
	} {
		const direct = result as {
			result?: Array<Record<string, unknown>>;
			issues?: Array<Record<string, unknown>>;
		};
		if (Array.isArray(direct.result)) return { issues: direct.result };
		if (Array.isArray(direct.issues)) return { issues: direct.issues };
		if (Array.isArray(result)) {
			return { issues: result as Array<Record<string, unknown>> };
		}
		return { issues: [] };
	}

	type RankedIssue = {
		issue: Record<string, unknown>;
		score: number;
		key: string | null;
		index: number;
	};

	function getIssueField(
		issue: Record<string, unknown>,
		keys: string[],
	): string {
		for (const key of keys) {
			const value = issue[key];
			if (typeof value === "string" && value.trim()) {
				return value;
			}
		}
		return "";
	}

	function scoreIssue(
		issue: Record<string, unknown>,
		terms: string[],
	): number | null {
		if (!terms.length) return 0;
		const summary = normalizeForMatch(
			getIssueField(issue, ["summary", "title"]),
		);
		const description = normalizeForMatch(
			getIssueField(issue, ["description"]),
		);
		const tags = Array.isArray(issue.tags)
			? normalizeForMatch(issue.tags.map((tag) => String(tag)).join(" "))
			: "";
		const key = normalizeForMatch(getIssueField(issue, ["key"]));

		let score = 0;
		for (const term of terms) {
			const normalized = normalizeForMatch(term);
			if (!normalized) continue;
			if (summary.includes(normalized)) score += 5;
			if (description.includes(normalized)) score += 2;
			if (tags.includes(normalized)) score += 1;
			if (key.includes(normalized)) score += 10;
		}
		return score;
	}

	function rankIssues(
		issues: Array<Record<string, unknown>>,
		question: string,
	): RankedIssue[] {
		const terms = extractKeywords(question, 10);
		const ranked = issues
			.map((issue, index) => {
				const score = scoreIssue(issue, terms);
				if (score === null) return null;
				const key = getIssueField(issue, ["key"]);
				return {
					issue,
					score,
					key: key || null,
					index,
				} as RankedIssue;
			})
			.filter((item): item is RankedIssue => Boolean(item))
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				return a.index - b.index;
			});
		return ranked;
	}

	function extractCommentsText(result: TrackerToolResult): {
		text: string;
		truncated: boolean;
	} {
		let comments: string[] = [];
		const direct = result as Array<Record<string, unknown>> | null;
		if (Array.isArray(direct)) {
			comments = direct
				.map((item) => {
					const text =
						(item.text as string | undefined) ??
						(item.comment as string | undefined) ??
						(item.body as string | undefined);
					return typeof text === "string" ? text : "";
				})
				.filter((value) => value.length > 0);
		}

		const combined = comments.join("\n");
		const limit = 8000;
		if (combined.length > limit) {
			return { text: `${combined.slice(0, limit)}…`, truncated: true };
		}
		return { text: combined, truncated: false };
	}

	function buildIssuesQuery(question: string, queue: string): string {
		const terms = extractKeywords(question);
		if (!terms.length) {
			const safe = question.replaceAll('"', "");
			return `Queue:${queue} AND (Summary: "${safe}" OR Description: "${safe}")`;
		}
		const expanded = terms.flatMap((term) => expandTermVariants(term));
		const unique = Array.from(new Set(expanded));
		const orTerms = unique.flatMap((term) => {
			const safe = term.replaceAll('"', "");
			return [`Summary: "${safe}"`, `Description: "${safe}"`];
		});
		return `Queue:${queue} AND (${orTerms.join(" OR ")})`;
	}

	function setActiveModel(refOverride: string) {
		const selected = selectModel(modelsConfig, refOverride);
		activeModelRef = selected.ref;
		activeModelConfig = selected.config;
		activeModelFallbacks = selected.fallbacks;
	}

	function normalizeReasoning(input: string): string | null {
		const value = input.trim().toLowerCase();
		if (!value) return null;
		if (["off", "low", "standard", "high"].includes(value)) return value;
		return null;
	}

	function trackerHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `OAuth ${TRACKER_TOKEN}`,
		};
		if (TRACKER_CLOUD_ORG_ID) {
			headers["X-Cloud-Org-Id"] = TRACKER_CLOUD_ORG_ID;
		} else if (TRACKER_ORG_ID) {
			headers["X-Org-Id"] = TRACKER_ORG_ID;
		}
		return headers;
	}

	function jiraHeaders(): Record<string, string> {
		const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString(
			"base64",
		);
		return {
			Authorization: `Basic ${token}`,
			Accept: "application/json",
		};
	}

	function buildJiraUrl(pathname: string, query?: Record<string, string>) {
		const base = new URL(JIRA_BASE_URL);
		const basePath = base.pathname.endsWith("/")
			? base.pathname.slice(0, -1)
			: base.pathname;
		const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
		base.pathname = `${basePath}${path}`;
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== "") {
					base.searchParams.set(key, value);
				}
			}
		}
		return base.toString();
	}

	async function jiraRequest<T>(
		method: string,
		pathname: string,
		options: {
			query?: Record<string, string>;
			body?: unknown;
			timeoutMs?: number;
		} = {},
	): Promise<T> {
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? 30_000;
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const headers = jiraHeaders();
			const init: RequestInit = {
				method,
				headers,
				signal: controller.signal,
			};
			if (options.body !== undefined) {
				headers["Content-Type"] = "application/json";
				init.body = JSON.stringify(options.body);
			}
			const url = buildJiraUrl(pathname, options.query);
			const response = await fetch(url, init);
			const text = await response.text();
			if (!response.ok) {
				throw new Error(
					`jira_error:${response.status}:${response.statusText}:${text}`,
				);
			}
			if (!text.trim()) return undefined as T;
			try {
				return JSON.parse(text) as T;
			} catch {
				return text as T;
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	function getJiraCachedComments(
		issueKey: string,
	): { text: string; truncated: boolean } | null {
		const cached = jiraCommentsCache.get(issueKey);
		if (!cached) return null;
		if (Date.now() - cached.at > COMMENTS_CACHE_TTL_MS) {
			jiraCommentsCache.delete(issueKey);
			return null;
		}
		return cached.value;
	}

	function setJiraCachedComments(
		issueKey: string,
		value: { text: string; truncated: boolean },
	) {
		jiraCommentsCache.set(issueKey, { at: Date.now(), value });
		if (jiraCommentsCache.size <= COMMENTS_CACHE_MAX) return;
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of jiraCommentsCache.entries()) {
			if (entry.at < oldestAt) {
				oldestAt = entry.at;
				oldestKey = key;
			}
		}
		if (oldestKey) jiraCommentsCache.delete(oldestKey);
	}

	function buildTrackerUrl(pathname: string, query?: Record<string, string>) {
		const base = new URL(TRACKER_API_BASE_URL);
		const basePath = base.pathname.endsWith("/")
			? base.pathname.slice(0, -1)
			: base.pathname;
		const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
		base.pathname = `${basePath}${path}`;
		const url = base;
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== "") {
					url.searchParams.set(key, value);
				}
			}
		}
		return url.toString();
	}

	async function trackerRequest<T>(
		method: string,
		pathname: string,
		options: {
			query?: Record<string, string>;
			body?: unknown;
			timeoutMs?: number;
		} = {},
	): Promise<T> {
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? 30_000;
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const headers = trackerHeaders();
			const init: RequestInit = {
				method,
				headers,
				signal: controller.signal,
			};
			if (options.body !== undefined) {
				headers["Content-Type"] = "application/json";
				init.body = JSON.stringify(options.body);
			}
			const url = buildTrackerUrl(pathname, options.query);
			const response = await fetch(url, init);
			const text = await response.text();
			if (!response.ok) {
				throw new Error(
					`tracker_error:${response.status}:${response.statusText}:${text}`,
				);
			}
			if (!text.trim()) return undefined as T;
			try {
				return JSON.parse(text) as T;
			} catch {
				return text as T;
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	async function trackerIssuesFind(options: {
		query: string;
		perPage?: number;
		page?: number;
		timeoutMs?: number;
	}) {
		if (!options.query) return [];
		return trackerRequest<Array<Record<string, unknown>>>(
			"POST",
			"/v3/issues/_search",
			{
				query: {
					perPage: String(options.perPage ?? 100),
					page: String(options.page ?? 1),
				},
				body: { query: options.query },
				timeoutMs: options.timeoutMs,
			},
		);
	}

	async function trackerIssueGet(issueId: string, timeoutMs?: number) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Record<string, unknown>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}`,
			{ timeoutMs },
		);
	}

	async function trackerIssueGetComments(issueId: string, timeoutMs?: number) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}/comments`,
			{ timeoutMs },
		);
	}

	async function trackerHealthCheck() {
		return trackerRequest<Record<string, unknown>>("GET", "/v3/myself");
	}

	type TrackerToolResult = unknown;

	type JiraSearchResponse = {
		issues?: JiraIssue[];
	};

	type JiraCommentsResponse = {
		comments?: Array<{
			body?: unknown;
		}>;
	};

	type JiraSprintResponse = {
		values?: Array<{
			id: number;
			name: string;
			state?: string;
			startDate?: string;
			endDate?: string;
			completeDate?: string;
		}>;
		isLast?: boolean;
		startAt?: number;
		maxResults?: number;
	};

	type JiraSprintIssue = {
		key?: string;
		fields?: {
			summary?: string;
			status?: { name?: string };
			assignee?: { displayName?: string };
			duedate?: string;
			priority?: { name?: string };
		};
	};

	async function jiraIssuesFind(options: {
		jql: string;
		maxResults?: number;
		fields?: string[];
		timeoutMs?: number;
	}) {
		if (!options.jql) return [];
		const fields = options.fields ?? ["summary", "description"];
		const payload = {
			jql: options.jql,
			maxResults: options.maxResults ?? 50,
			fields,
		};
		const response = await jiraRequest<JiraSearchResponse>(
			"POST",
			"/rest/api/3/search/jql",
			{ body: payload, timeoutMs: options.timeoutMs },
		);
		return response.issues ?? [];
	}

	async function jiraIssueGet(issueKey: string, timeoutMs?: number) {
		if (!issueKey) throw new Error("missing_issue_key");
		return jiraRequest<JiraIssue>(
			"GET",
			`/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
			{
				query: { fields: "summary,description" },
				timeoutMs,
			},
		);
	}

	async function jiraIssueGetComments(
		options: { issueKey: string; maxResults?: number },
		timeoutMs?: number,
	): Promise<{ text: string; truncated: boolean }> {
		if (!options.issueKey) throw new Error("missing_issue_key");
		const response = await jiraRequest<JiraCommentsResponse>(
			"GET",
			`/rest/api/3/issue/${encodeURIComponent(options.issueKey)}/comment`,
			{
				query: { maxResults: String(options.maxResults ?? 100) },
				timeoutMs,
			},
		);
		const comments = response.comments ?? [];
		const texts = comments.map((comment) => extractJiraText(comment.body));
		const joined = texts.join("\n\n").trim();
		const truncated = joined.length > 4000;
		return { text: joined.slice(0, 4000), truncated };
	}

	async function jiraSprintsList(
		boardId: number,
		timeoutMs?: number,
	): Promise<JiraSprintResponse["values"]> {
		const results: NonNullable<JiraSprintResponse["values"]> = [];
		let startAt = 0;
		const maxResults = 50;
		while (true) {
			const response = await jiraRequest<JiraSprintResponse>(
				"GET",
				`/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/sprint`,
				{
					query: {
						startAt: String(startAt),
						maxResults: String(maxResults),
						state: "active,future,closed",
					},
					timeoutMs,
				},
			);
			const values = response.values ?? [];
			results.push(...values);
			if (response.isLast || values.length === 0) break;
			startAt += maxResults;
		}
		return results;
	}

	async function jiraSprintFindByName(boardId: number, name: string) {
		const target = normalizeSprintName(name);
		const sprints = (await jiraSprintsList(boardId, 30_000)) ?? [];
		const exact = sprints.find(
			(sprint) => normalizeSprintName(sprint.name ?? "") === target,
		);
		if (exact) return exact;
		return sprints.find((sprint) =>
			normalizeSprintName(sprint.name ?? "").includes(target),
		);
	}

	async function jiraSprintIssues(sprintId: number, maxResults?: number) {
		const results: JiraSprintIssue[] = [];
		let startAt = 0;
		const pageSize = Math.min(Math.max(maxResults ?? 50, 1), 100);
		while (results.length < (maxResults ?? Number.POSITIVE_INFINITY)) {
			const response = await jiraRequest<{ issues?: JiraSprintIssue[] }>(
				"GET",
				`/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}/issue`,
				{
					query: {
						startAt: String(startAt),
						maxResults: String(pageSize),
						fields: "summary,status,assignee,duedate,priority",
					},
					timeoutMs: 30_000,
				},
			);
			const batch = response.issues ?? [];
			results.push(...batch);
			if (batch.length < pageSize) break;
			startAt += pageSize;
			if (maxResults && results.length >= maxResults) break;
		}
		return results.slice(0, maxResults ?? results.length).map((issue) => ({
			key: issue.key ?? "",
			summary:
				typeof issue.fields?.summary === "string" ? issue.fields.summary : "",
			status: issue.fields?.status?.name ?? "",
			assignee: issue.fields?.assignee?.displayName ?? "",
			dueDate: issue.fields?.duedate ?? "",
			priority: issue.fields?.priority?.name ?? "",
		}));
	}

	function logJiraAudit(
		ctx: BotContext | undefined,
		toolName: string,
		args: Record<string, unknown>,
		outcome: "success" | "error",
		error?: string,
		durationMs?: number,
	) {
		const context = ctx ? getLogContext(ctx) : {};
		const issueKey =
			typeof args.issueKey === "string" ? args.issueKey : undefined;
		const jql = typeof args.jql === "string" ? args.jql : undefined;
		const payload = {
			event: "jira_tool",
			outcome,
			tool: toolName,
			issue_key: issueKey,
			jql_len: jql ? jql.length : undefined,
			request_id: context.request_id,
			chat_id: context.chat_id,
			user_id: context.user_id,
			username: context.username,
			duration_ms: durationMs,
			error,
		};
		const level = outcome === "error" ? "error" : "info";
		logger[level](payload);
	}

	function extractIssueKey(args: Record<string, unknown>): string | undefined {
		const raw = args.issue_id ?? args.issueId ?? args.key;
		return typeof raw === "string" && raw.trim().length > 0
			? raw.trim()
			: undefined;
	}

	function logTrackerAudit(
		ctx: BotContext | undefined,
		toolName: string,
		args: Record<string, unknown>,
		outcome: "success" | "error",
		error?: string,
		durationMs?: number,
	) {
		const context = ctx ? getLogContext(ctx) : {};
		const issueKey = extractIssueKey(args);
		const query = typeof args.query === "string" ? args.query : undefined;
		const payload = {
			event: "tracker_tool",
			outcome,
			tool: toolName,
			issue_key: issueKey,
			query_len: query ? query.length : undefined,
			request_id: context.request_id,
			chat_id: context.chat_id,
			user_id: context.user_id,
			username: context.username,
			duration_ms: durationMs,
			error,
		};
		const level = outcome === "error" ? "error" : "info";
		logger[level](payload);
	}

	async function trackerCallTool<T = TrackerToolResult>(
		toolName: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		ctx?: BotContext,
	): Promise<T> {
		lastTrackerCallAt = Date.now();
		if (ctx) {
			setLogContext(ctx, {
				tool: toolName,
				issue_key: extractIssueKey(args),
			});
		}
		const startedAt = Date.now();
		try {
			switch (toolName) {
				case "issues_find": {
					const query = String(args.query ?? "");
					const perPage = Number(args.per_page ?? args.perPage ?? 100);
					const page = Number(args.page ?? 1);
					const result = await trackerIssuesFind({
						query,
						perPage: Number.isFinite(perPage) ? perPage : 100,
						page: Number.isFinite(page) ? page : 1,
						timeoutMs,
					});
					logTrackerAudit(
						ctx,
						toolName,
						args,
						"success",
						undefined,
						Date.now() - startedAt,
					);
					return result as T;
				}
				case "issue_get": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGet(issueId, timeoutMs);
					logTrackerAudit(
						ctx,
						toolName,
						args,
						"success",
						undefined,
						Date.now() - startedAt,
					);
					return result as T;
				}
				case "issue_get_comments": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGetComments(issueId, timeoutMs);
					logTrackerAudit(
						ctx,
						toolName,
						args,
						"success",
						undefined,
						Date.now() - startedAt,
					);
					return result as T;
				}
				case "issue_get_url": {
					const issueId = String(args.issue_id ?? "");
					logTrackerAudit(
						ctx,
						toolName,
						args,
						"success",
						undefined,
						Date.now() - startedAt,
					);
					return `https://tracker.yandex.ru/${issueId}` as unknown as T;
				}
				default:
					throw new Error(`unknown_tool:${toolName}`);
			}
		} catch (error) {
			logTrackerAudit(
				ctx,
				toolName,
				args,
				"error",
				String(error),
				Date.now() - startedAt,
			);
			throw error;
		}
	}

	function withTimeout<T>(
		promise: Promise<T>,
		ms: number,
		label: string,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
				ms,
			);
			promise
				.then((value) => {
					clearTimeout(timer);
					resolve(value);
				})
				.catch((error) => {
					clearTimeout(timer);
					reject(error);
				});
		});
	}

	function formatUptime(seconds: number): string {
		const total = Math.floor(seconds);
		const days = Math.floor(total / 86400);
		const hours = Math.floor((total % 86400) / 3600);
		const mins = Math.floor((total % 3600) / 60);
		const secs = total % 60;
		if (days > 0) return `${days}d ${hours}h ${mins}m ${secs}s`;
		if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
		if (mins > 0) return `${mins}m ${secs}s`;
		return `${secs}s`;
	}

	const startKeyboard = new InlineKeyboard()
		.text("Помощь", "cmd:help")
		.text("Статус", "cmd:status");

	const START_GREETING =
		"Привет!\n\n" +
		"Я Омни, персональный ассистент.\n" +
		"Отвечаю по задачам, статусам и итогам, могу искать в интернете.\n" +
		"Можно писать текстом или голосом.\n" +
		"Если есть номер задачи — укажите его, например PROJ-1234.\n\n";

	bot.command("start", (ctx) => {
		setLogContext(ctx, { command: "/start", message_type: "command" });
		const memoryId = ctx.from?.id?.toString() ?? "";
		if (memoryId) {
			clearHistoryMessages();
		}
		return sendText(ctx, START_GREETING, { reply_markup: startKeyboard });
	});

	async function handleHelp(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		await sendText(
			ctx,
			"Команды:\n" +
				"/tools - показать доступные инструменты\n" +
				"/model - показать или сменить модель (list — список, set — выбрать)\n" +
				"/model list - показать список моделей\n" +
				"/model set <ref> - выбрать модель по имени\n" +
				"/model reasoning <level> - установить уровень логики ответа (off/low/standard/high)\n" +
				"/whoami - кто такой бот\n" +
				"/tracker <tool> <json> - вручную вызвать инструмент с параметрами (для продвинутых)\n\n" +
				"Можно просто спросить, например:\n" +
				'"Делали интеграцию с ЦИАН?"',
		);
	}

	bot.command("help", (ctx) => {
		setLogContext(ctx, { command: "/help", message_type: "command" });
		return handleHelp(ctx);
	});

	async function handleTools(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		try {
			const tools = await getCommandTools();
			const chatPolicy = resolveChatToolPolicy(ctx as BotContext);
			const effectivePolicy = mergeToolPolicies(toolPolicy, chatPolicy);
			const filteredTools = filterToolMetasByPolicy(tools, effectivePolicy);
			if (!tools.length) {
				await sendText(ctx, "Нет доступных инструментов.");
				return;
			}

			const lines = filteredTools.map((tool) => {
				const desc = tool.description ? ` - ${tool.description}` : "";
				return `${tool.name}${desc}`;
			});

			const conflictLines =
				TOOL_CONFLICTS.length > 0
					? TOOL_CONFLICTS.map(
							(conflict) =>
								`- ${conflict.tool.name} (duplicate name, source ${conflict.tool.source})`,
						)
					: [];
			const suppressedLines = (() => {
				const globalSuppressed =
					TOOL_SUPPRESSED_BY_POLICY.length > 0 ? TOOL_SUPPRESSED_BY_POLICY : [];
				if (!chatPolicy) return globalSuppressed;
				const chatSuppressed = tools
					.filter((tool) => !filteredTools.includes(tool))
					.map((tool) => tool.name);
				return Array.from(new Set([...globalSuppressed, ...chatSuppressed]));
			})();
			const approvalLines =
				approvalRequired.size > 0
					? Array.from(approvalRequired).map((name) => `- ${name}`)
					: [];
			const rateRules = parseToolRateLimits(TOOL_RATE_LIMITS);
			const rateLimitLines =
				rateRules.length > 0
					? [
							"Лимиты (на пользователя и чат):",
							...rateRules.map(
								(rule) => `- ${rule.tool}: ${rule.max}/${rule.windowSeconds}s`,
							),
						]
					: [];
			const sections = [
				`Доступные инструменты:\n${lines.join("\n")}`,
				conflictLines.length > 0
					? `\nКонфликты:\n${conflictLines.join("\n")}`
					: "",
				suppressedLines.length > 0
					? `\nОтключены политикой:\n${suppressedLines.map((name) => `- ${name}`).join("\n")}`
					: "",
				approvalLines.length > 0
					? `\nТребуют одобрения:\n${approvalLines.join("\n")}`
					: "",
				rateLimitLines.length > 0 ? `\n${rateLimitLines.join("\n")}` : "",
			].filter(Boolean);

			await sendText(ctx, sections.join("\n"));
		} catch (error) {
			await sendText(ctx, `Ошибка списка инструментов: ${String(error)}`);
		}
	}

	bot.command("tools", (ctx) => {
		setLogContext(ctx, { command: "/tools", message_type: "command" });
		return handleTools(ctx);
	});

	bot.command("approve", async (ctx) => {
		setLogContext(ctx, { command: "/approve", message_type: "command" });
		const text = ctx.message?.text ?? "";
		const [, toolRaw] = text.split(" ");
		const chatId = ctx.chat?.id?.toString() ?? "";
		if (!chatId) {
			await sendText(ctx, "Нет chat_id для одобрения.");
			return;
		}
		if (!toolRaw) {
			const list =
				approvalRequired.size > 0
					? Array.from(approvalRequired).join(", ")
					: "нет";
			await sendText(
				ctx,
				`Использование: /approve <tool>\nТребуют одобрения: ${list}`,
			);
			return;
		}
		const normalized = normalizeToolName(toolRaw);
		if (!approvalRequired.has(normalized)) {
			await sendText(ctx, `Инструмент ${normalized} не требует одобрения.`);
			return;
		}
		approvalStore.approve(chatId, normalized);
		await sendText(ctx, `Одобрено: ${normalized}. Повторите запрос.`);
	});

	bot.command("approvals", async (ctx) => {
		setLogContext(ctx, { command: "/approvals", message_type: "command" });
		const chatId = ctx.chat?.id?.toString() ?? "";
		if (!chatId) {
			await sendText(ctx, "Нет chat_id для списка одобрений.");
			return;
		}
		const approvals = listApprovals(approvalStore, chatId);
		if (approvals.length === 0) {
			await sendText(ctx, "Активных одобрений нет.");
			return;
		}
		const lines = approvals.map(
			(item) => `- ${item.tool} (до ${new Date(item.expiresAt).toISOString()})`,
		);
		await sendText(ctx, `Активные одобрения:\n${lines.join("\n")}`);
	});

	bot.command("model", async (ctx) => {
		setLogContext(ctx, { command: "/model", message_type: "command" });
		const text = ctx.message?.text ?? "";
		const [, sub, ...rest] = text.split(" ");
		if (sub) setLogContext(ctx, { command_sub: sub });

		if (!sub) {
			const fallbacks = activeModelFallbacks.length
				? activeModelFallbacks.join(", ")
				: "none";
			await sendText(
				ctx,
				`Model: ${activeModelRef}\nReasoning: ${resolveReasoning()}\nFallbacks: ${fallbacks}`,
			);
			return;
		}

		if (sub === "list") {
			const lines = Object.entries(modelsConfig.models).map(([ref, cfg]) => {
				const label = cfg.label ?? cfg.id;
				return `${ref} - ${label}`;
			});
			await sendText(ctx, `Available models:\n${lines.join("\n")}`);
			return;
		}

		if (sub === "set") {
			const raw = rest.join(" ").trim();
			if (!raw) {
				await sendText(ctx, "Использование: /model set <ref>");
				return;
			}
			const normalized = normalizeModelRef(raw);
			try {
				setActiveModel(normalized);
				await sendText(ctx, `Model set to ${activeModelRef}`);
			} catch (error) {
				await sendText(ctx, `Ошибка модели: ${String(error)}`);
			}
			return;
		}

		if (sub === "reasoning") {
			const raw = rest.join(" ").trim();
			const normalized = normalizeReasoning(raw);
			if (!normalized) {
				await sendText(ctx, "Reasoning must be off|low|standard|high");
				return;
			}
			activeReasoningOverride = normalized;
			await sendText(ctx, `Reasoning set to ${normalized}`);
			return;
		}

		await sendText(ctx, "Unknown /model subcommand");
	});

	bot.command("skills", async (ctx) => {
		setLogContext(ctx, { command: "/skills", message_type: "command" });
		if (!filteredRuntimeSkills.length) {
			await sendText(ctx, "Нет доступных runtime-skills.");
			return;
		}
		const lines = filteredRuntimeSkills.map((skill) => {
			const desc = skill.description ? ` - ${skill.description}` : "";
			return `${skill.name}${desc}`;
		});
		await sendText(ctx, `Доступные runtime-skills:\n${lines.join("\n")}`);
	});

	bot.command("skill", async (ctx) => {
		setLogContext(ctx, { command: "/skill", message_type: "command" });
		if (isGroupChat(ctx) && TELEGRAM_GROUP_REQUIRE_MENTION) {
			const allowReply =
				ctx.message?.reply_to_message?.from?.id !== undefined &&
				ctx.me?.id !== undefined &&
				ctx.message.reply_to_message.from.id === ctx.me.id;
			if (!allowReply && !isBotMentioned(ctx)) {
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				return;
			}
		}
		const text = ctx.message?.text ?? "";
		const [, skillName, ...rest] = text.split(" ");
		if (!skillName) {
			await sendText(ctx, "Использование: /skill <name> <json>");
			return;
		}
		const skill = filteredRuntimeSkills.find((item) => item.name === skillName);
		if (!skill) {
			await sendText(ctx, `Неизвестный skill: ${skillName}`);
			return;
		}

		const rawArgs = rest.join(" ").trim();
		let args: Record<string, unknown> = {};
		if (rawArgs) {
			try {
				args = JSON.parse(rawArgs) as Record<string, unknown>;
			} catch (error) {
				await sendText(ctx, `Некорректный JSON: ${String(error)}`);
				return;
			}
		}

		const mergedArgs = { ...(skill.args ?? {}), ...args };
		const { server, tool } = resolveToolRef(skill.tool);
		if (!tool) {
			await sendText(ctx, `Некорректный tool в skill: ${skill.name}`);
			return;
		}
		if (server !== "yandex-tracker") {
			await sendText(ctx, `Неподдерживаемый tool server: ${server}`);
			return;
		}

		try {
			const result = await trackerCallTool(
				tool,
				mergedArgs,
				skill.timeoutMs ?? 30_000,
				ctx,
			);
			const text = formatToolResult(result);
			if (text) {
				await sendText(ctx, text);
				return;
			}
			await sendText(ctx, "Skill выполнился, но не вернул текст.");
		} catch (error) {
			await sendText(ctx, `Ошибка вызова skill: ${String(error)}`);
		}
	});

	async function handleStatus(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		const uptimeSeconds = options.getUptimeSeconds?.() ?? 0;
		const uptime = formatUptime(uptimeSeconds);
		let trackerStatus = "ok";
		let trackerInfo = "";
		try {
			await withTimeout(trackerHealthCheck(), 5_000, "trackerHealthCheck");
			trackerInfo = "ok";
		} catch (error) {
			trackerStatus = "error";
			trackerInfo = String(error);
		}

		const lastCall = lastTrackerCallAt
			? new Date(lastTrackerCallAt).toISOString()
			: "n/a";
		await sendText(
			ctx,
			[
				"Status:",
				`uptime: ${uptime}`,
				`model: ${activeModelRef}`,
				`tracker: ${trackerStatus} (${trackerInfo})`,
				`last_tracker_call: ${lastCall}`,
			].join("\n"),
		);
	}

	bot.command("status", (ctx) => {
		setLogContext(ctx, { command: "/status", message_type: "command" });
		return handleStatus(ctx);
	});

	bot.command("whoami", (ctx) => {
		setLogContext(ctx, { command: "/whoami", message_type: "command" });
		return sendText(ctx, "Я Omni, ассистент по Yandex Tracker.");
	});

	async function safeAnswerCallback(ctx: {
		answerCallbackQuery: () => Promise<unknown>;
	}) {
		try {
			await ctx.answerCallbackQuery();
		} catch (error) {
			logDebug("callback_query answer failed", { error: String(error) });
		}
	}

	async function refreshInlineKeyboard(ctx: CallbackQueryContext<BotContext>) {
		try {
			await ctx.editMessageReplyMarkup({
				reply_markup: startKeyboard,
			});
		} catch (error) {
			logDebug("callback_query refresh keyboard failed", {
				error: String(error),
			});
		}
	}

	bot.callbackQuery(/^cmd:(help|status)$/, async (ctx) => {
		setLogContext(ctx, { message_type: "callback" });
		await safeAnswerCallback(ctx);
		const command = ctx.match?.[1];
		if (command === "help") {
			setLogContext(ctx, { command: "cmd:help" });
			await handleHelp(ctx);
			await refreshInlineKeyboard(ctx);
			return;
		}
		if (command === "status") {
			setLogContext(ctx, { command: "cmd:status" });
			await handleStatus(ctx);
			await refreshInlineKeyboard(ctx);
		}
	});

	bot.on("callback_query:data", async (ctx) => {
		setLogContext(ctx, { message_type: "callback" });
		await safeAnswerCallback(ctx);
	});

	bot.command("tracker", async (ctx) => {
		setLogContext(ctx, { command: "/tracker", message_type: "command" });
		if (isGroupChat(ctx) && TELEGRAM_GROUP_REQUIRE_MENTION) {
			const allowReply =
				ctx.message?.reply_to_message?.from?.id !== undefined &&
				ctx.me?.id !== undefined &&
				ctx.message.reply_to_message.from.id === ctx.me.id;
			if (!allowReply && !isBotMentioned(ctx)) {
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				return;
			}
		}
		const text = ctx.message?.text ?? "";
		const [, toolName, ...rest] = text.split(" ");
		if (!toolName) {
			await sendText(ctx, "Использование: /tracker <tool> <json>");
			return;
		}
		setLogContext(ctx, { tool: toolName });

		if (!SUPPORTED_TRACKER_TOOLS.has(toolName)) {
			await sendText(
				ctx,
				`Неподдерживаемый инструмент: ${toolName}. Используйте: ${Array.from(SUPPORTED_TRACKER_TOOLS).join(", ")}`,
			);
			return;
		}

		const rawArgs = rest.join(" ").trim();
		let args: Record<string, unknown> = {};
		if (rawArgs) {
			try {
				args = JSON.parse(rawArgs) as Record<string, unknown>;
			} catch (error) {
				await sendText(ctx, `Некорректный JSON: ${String(error)}`);
				return;
			}
		}

		try {
			const result = await trackerCallTool(toolName, args, 30_000, ctx);
			const text = formatToolResult(result);
			if (text) {
				await sendText(ctx, text);
				return;
			}
			await sendText(ctx, "Инструмент выполнился, но не вернул текст.");
		} catch (error) {
			await sendText(ctx, `Ошибка вызова инструмента: ${String(error)}`);
		}
	});

	async function sendText(
		ctx: {
			reply: (
				text: string,
				options?: Record<string, unknown>,
			) => Promise<unknown>;
		},
		text: string,
		options?: Record<string, unknown>,
	) {
		const limit =
			Number.isFinite(TELEGRAM_TEXT_CHUNK_LIMIT) &&
			TELEGRAM_TEXT_CHUNK_LIMIT > 0
				? TELEGRAM_TEXT_CHUNK_LIMIT
				: 4000;
		const replyOptions = options?.parse_mode
			? options
			: { ...(options ?? {}), parse_mode: "HTML" };
		const formatted = formatTelegram(text);

		try {
			if (formatted.length <= limit) {
				await ctx.reply(formatted, replyOptions);
				return;
			}
			for (let i = 0; i < formatted.length; i += limit) {
				const chunk = formatted.slice(i, i + limit);
				await ctx.reply(chunk, replyOptions);
			}
			return;
		} catch (error) {
			logDebug("telegram html reply failed, retrying as plain text", {
				error: String(error),
			});
		}

		const plainOptions = { ...(options ?? {}) };
		delete (plainOptions as { parse_mode?: string }).parse_mode;
		if (text.length <= limit) {
			await ctx.reply(text, plainOptions);
			return;
		}
		for (let i = 0; i < text.length; i += limit) {
			const chunk = text.slice(i, i + limit);
			await ctx.reply(chunk, plainOptions);
		}
	}

	function escapeHtml(input: string) {
		return input
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");
	}

	function formatTelegram(input: string) {
		if (!input) return "";

		const codeBlocks: string[] = [];
		const inlineCodes: string[] = [];
		let text = input;

		text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
			void match;
			const escaped = escapeHtml(String(code).trimEnd());
			const html = `<pre><code>${escaped}</code></pre>`;
			const token = `@@CODEBLOCK_${codeBlocks.length}@@`;
			codeBlocks.push(html);
			return token;
		});

		text = text.replace(/`([^`]+?)`/g, (match, code) => {
			void match;
			const escaped = escapeHtml(String(code));
			const html = `<code>${escaped}</code>`;
			const token = `@@INLINECODE_${inlineCodes.length}@@`;
			inlineCodes.push(html);
			return token;
		});

		text = escapeHtml(text);

		text = text.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
			(match, label, url) => {
				void match;
				return `<a href="${url}">${label}</a>`;
			},
		);
		text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
		text = text.replace(/\*([^*]+)\*/g, "<i>$1</i>");
		text = text.replace(/_([^_]+)_/g, "<i>$1</i>");
		text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");

		text = text.replace(/@@INLINECODE_(\d+)@@/g, (match, index) => {
			void match;
			const entry = inlineCodes[Number(index)];
			return entry ?? "";
		});
		text = text.replace(/@@CODEBLOCK_(\d+)@@/g, (match, index) => {
			void match;
			const entry = codeBlocks[Number(index)];
			return entry ?? "";
		});

		return text;
	}

	function appendSources(text: string, sources: Array<{ url?: string }> = []) {
		const urls = sources
			.map((source) => source.url)
			.filter((url): url is string => Boolean(url));
		if (!urls.length) return text;
		const unique = Array.from(new Set(urls));
		const lines = unique.map((url) => `- ${url}`);
		return `${text}\n\nИсточники:\n${lines.join("\n")}`;
	}

	bot.on("message:text", async (ctx) => {
		setLogContext(ctx, { message_type: "text" });
		const text = ctx.message.text.trim();
		await handleIncomingText(ctx, text);
	});

	bot.on("message:voice", async (ctx) => {
		setLogContext(ctx, { message_type: "voice" });
		const voice = ctx.message.voice;
		if (!voice?.file_id) {
			await sendText(ctx, "Не удалось прочитать голосовое сообщение.");
			return;
		}
		try {
			await ctx.replyWithChatAction("typing");
			if (!isGroupAllowed(ctx)) {
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				await sendText(ctx, "Доступ запрещен.");
				return;
			}
			if (isGroupChat(ctx) && TELEGRAM_GROUP_REQUIRE_MENTION) {
				const allowReply =
					ctx.message?.reply_to_message?.from?.id !== undefined &&
					ctx.me?.id !== undefined &&
					ctx.message.reply_to_message.from.id === ctx.me.id;
				if (!allowReply) {
					setLogContext(ctx, { outcome: "blocked", status_code: 403 });
					return;
				}
			}
			const file = await ctx.api.getFile(voice.file_id);
			if (!file.file_path) {
				await sendText(ctx, "Не удалось получить файл голосового сообщения.");
				return;
			}
			const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
			const response = await fetch(downloadUrl);
			if (!response.ok) {
				throw new Error(`audio_download_failed:${response.status}`);
			}
			const audio = new Uint8Array(await response.arrayBuffer());
			const transcript = await transcribe({
				model: openai.transcription("gpt-4o-mini-transcribe"),
				audio,
			});
			const text = transcript.text?.trim() ?? "";
			if (!text) {
				await sendText(ctx, "Не удалось распознать речь в сообщении.");
				return;
			}
			logDebug("voice transcript", { length: text.length });
			await handleIncomingText(ctx, text);
		} catch (error) {
			logDebug("voice transcription error", { error: String(error) });
			setLogError(ctx, error);
			await sendText(ctx, `Ошибка: ${String(error)}`);
		}
	});

	async function handleIncomingText(ctx: BotContext, rawText: string) {
		const text = rawText.trim();
		if (!text || text.startsWith("/")) {
			return;
		}
		const replyToMessageId = isGroupChat(ctx)
			? ctx.message?.message_id
			: undefined;
		const replyOptions = replyToMessageId
			? { reply_to_message_id: replyToMessageId }
			: undefined;
		const sendReply = (message: string) => sendText(ctx, message, replyOptions);
		const { onToolStep, clearAllStatuses } = createToolStatusHandler(sendReply);

		try {
			await ctx.replyWithChatAction("typing");
			if (!isGroupAllowed(ctx)) {
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				await sendText(ctx, "Доступ запрещен.");
				return;
			}
			if (isGroupChat(ctx) && TELEGRAM_GROUP_REQUIRE_MENTION) {
				const allowReply =
					ctx.message?.reply_to_message?.from?.id !== undefined &&
					ctx.me?.id !== undefined &&
					ctx.message.reply_to_message.from.id === ctx.me.id;
				if (!allowReply && !isBotMentioned(ctx)) {
					setLogContext(ctx, { outcome: "blocked", status_code: 403 });
					return;
				}
			}
			const chatId = ctx.chat?.id?.toString() ?? "";
			const memoryId = ctx.from?.id?.toString() ?? chatId;
			const userName = ctx.from?.first_name?.trim() || undefined;
			const chatState = chatId ? getChatState(chatId) : null;
			const historyMessages =
				memoryId && Number.isFinite(HISTORY_MAX_MESSAGES)
					? await loadHistoryMessages(memoryId, HISTORY_MAX_MESSAGES, text)
					: [];
			const historyText = historyMessages.length
				? formatHistoryForPrompt(historyMessages)
				: "";
			const sprintQuery = isSprintQuery(text);
			const issueKeys = sprintQuery
				? extractExplicitIssueKeys(text)
				: extractIssueKeysFromText(text, DEFAULT_ISSUE_PREFIX);
			setLogContext(ctx, {
				issue_key_count: issueKeys.length,
				issue_key: issueKeys[0],
			});
			const jiraKeys = issueKeys.filter((key) => isJiraIssueKey(key));
			const trackerKeys = issueKeys.filter((key) => !isJiraIssueKey(key));
			if (issueKeys.length > 1 && jiraKeys.length === issueKeys.length) {
				try {
					const issuesData = await Promise.all(
						jiraKeys.slice(0, 5).map(async (key) => {
							const [issueResult, commentResult] = await Promise.all([
								jiraIssueGet(key, 30_000),
								jiraIssueGetComments({ issueKey: key }, 30_000),
							]);
							return {
								key,
								issueText: JSON.stringify(
									normalizeJiraIssue(issueResult),
									null,
									2,
								),
								commentsText: commentResult.text,
							};
						}),
					);
					const modelRefs = [
						activeModelRef,
						...activeModelFallbacks.filter((ref) => ref !== activeModelRef),
					];
					let lastError: unknown = null;
					for (const ref of modelRefs) {
						const config = getModelConfig(ref);
						if (!config) continue;
						try {
							setLogContext(ctx, { model_ref: ref, model_id: config.id });
							const agent = await createMultiIssueAgent({
								question: text,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issues: issuesData,
								userName,
							});
							const result = await agent.generate({ prompt: text });
							clearAllStatuses();
							const replyText = result.text?.trim();
							const sources = (result as { sources?: Array<{ url?: string }> })
								.sources;
							const reply = replyText
								? appendSources(replyText, sources)
								: replyText;
							if (!reply) {
								lastError = new Error("empty_response");
								continue;
							}
							if (chatState) {
								chatState.lastCandidates = issuesData.map((issue) => ({
									key: issue.key,
									summary: "",
									score: 0,
								}));
								chatState.lastPrimaryKey = issuesData[0]?.key ?? null;
								chatState.lastUpdatedAt = Date.now();
							}
							if (memoryId) {
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "user",
									text,
								});
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "assistant",
									text: reply,
								});
							}
							await sendReply(reply);
							return;
						} catch (error) {
							lastError = error;
							logDebug("multi issue agent error", {
								ref,
								error: String(error),
							});
						}
					}
					setLogError(ctx, lastError ?? "unknown_error");
					await sendReply(`Ошибка: ${String(lastError ?? "unknown")}`);
					return;
				} catch (error) {
					setLogError(ctx, error);
					await sendReply(`Ошибка: ${String(error)}`);
					return;
				}
			}

			if (issueKeys.length > 1 && trackerKeys.length === issueKeys.length) {
				try {
					const issuesData = await Promise.all(
						issueKeys.slice(0, 5).map(async (key) => {
							const [issueResult, commentResult] = await Promise.all([
								trackerCallTool("issue_get", { issue_id: key }, 30_000, ctx),
								trackerCallTool(
									"issue_get_comments",
									{ issue_id: key },
									30_000,
									ctx,
								),
							]);
							return {
								key,
								issueText: formatToolResult(issueResult),
								commentsText: extractCommentsText(commentResult).text,
							};
						}),
					);
					const modelRefs = [
						activeModelRef,
						...activeModelFallbacks.filter((ref) => ref !== activeModelRef),
					];
					let lastError: unknown = null;
					for (const ref of modelRefs) {
						const config = getModelConfig(ref);
						if (!config) continue;
						try {
							setLogContext(ctx, { model_ref: ref, model_id: config.id });
							const agent = await createMultiIssueAgent({
								question: text,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issues: issuesData,
								userName,
							});
							const result = await agent.generate({ prompt: text });
							clearAllStatuses();
							const replyText = result.text?.trim();
							const sources = (result as { sources?: Array<{ url?: string }> })
								.sources;
							const reply = replyText
								? appendSources(replyText, sources)
								: replyText;
							if (!reply) {
								lastError = new Error("empty_response");
								continue;
							}
							if (chatState) {
								chatState.lastCandidates = issuesData.map((issue) => ({
									key: issue.key,
									summary: "",
									score: 0,
								}));
								chatState.lastPrimaryKey = issuesData[0]?.key ?? null;
								chatState.lastUpdatedAt = Date.now();
							}
							if (memoryId) {
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "user",
									text,
								});
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "assistant",
									text: reply,
								});
							}
							await sendReply(reply);
							return;
						} catch (error) {
							lastError = error;
							logDebug("multi issue agent error", {
								ref,
								error: String(error),
							});
						}
					}
					setLogError(ctx, lastError ?? "unknown_error");
					await sendReply(`Ошибка: ${String(lastError ?? "unknown")}`);
					return;
				} catch (error) {
					setLogError(ctx, error);
					await sendReply(`Ошибка: ${String(error)}`);
					return;
				}
			}

			const issueKey = issueKeys[0] ?? null;
			if (issueKey && isJiraIssueKey(issueKey)) {
				try {
					const [issueResult, commentResult] = await Promise.all([
						jiraIssueGet(issueKey, 30_000),
						jiraIssueGetComments({ issueKey }, 30_000),
					]);
					const issueText = JSON.stringify(
						normalizeJiraIssue(issueResult),
						null,
						2,
					);
					const commentsText = commentResult.text;

					const modelRefs = [
						activeModelRef,
						...activeModelFallbacks.filter((ref) => ref !== activeModelRef),
					];
					let lastError: unknown = null;
					for (const ref of modelRefs) {
						const config = getModelConfig(ref);
						if (!config) {
							logDebug("model missing", { ref });
							continue;
						}
						try {
							setLogContext(ctx, { model_ref: ref, model_id: config.id });
							const agent = await createIssueAgent({
								question: text,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issueKey,
								issueText,
								commentsText,
								userName,
							});
							const result = await agent.generate({ prompt: text });
							clearAllStatuses();
							const replyText = result.text?.trim();
							const sources = (result as { sources?: Array<{ url?: string }> })
								.sources;
							const reply = replyText
								? appendSources(replyText, sources)
								: replyText;
							if (!reply) {
								lastError = new Error("empty_response");
								continue;
							}
							if (chatState) {
								chatState.lastCandidates = [
									{ key: issueKey, summary: "", score: 0 },
								];
								chatState.lastPrimaryKey = issueKey;
								chatState.lastUpdatedAt = Date.now();
							}
							if (memoryId) {
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "user",
									text,
								});
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "assistant",
									text: reply,
								});
							}
							await sendReply(reply);
							return;
						} catch (error) {
							lastError = error;
							logDebug("issue agent error", { ref, error: String(error) });
						}
					}
					setLogError(ctx, lastError ?? "unknown_error");
					await sendReply(`Ошибка: ${String(lastError ?? "unknown")}`);
					return;
				} catch (error) {
					setLogError(ctx, error);
					await sendReply(`Ошибка: ${String(error)}`);
					return;
				}
			}

			if (issueKey && trackerKeys.length === issueKeys.length) {
				try {
					const [issueResult, commentResult] = await Promise.all([
						trackerCallTool("issue_get", { issue_id: issueKey }, 30_000, ctx),
						trackerCallTool(
							"issue_get_comments",
							{ issue_id: issueKey },
							30_000,
							ctx,
						),
					]);
					const issueText = formatToolResult(issueResult);
					const commentsText = extractCommentsText(commentResult).text;

					const modelRefs = [
						activeModelRef,
						...activeModelFallbacks.filter((ref) => ref !== activeModelRef),
					];
					let lastError: unknown = null;
					for (const ref of modelRefs) {
						const config = getModelConfig(ref);
						if (!config) {
							logDebug("model missing", { ref });
							continue;
						}
						try {
							setLogContext(ctx, { model_ref: ref, model_id: config.id });
							const agent = await createIssueAgent({
								question: text,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issueKey,
								issueText,
								commentsText,
								userName,
							});
							const result = await agent.generate({ prompt: text });
							clearAllStatuses();
							const replyText = result.text?.trim();
							const sources = (result as { sources?: Array<{ url?: string }> })
								.sources;
							const reply = replyText
								? appendSources(replyText, sources)
								: replyText;
							if (!reply) {
								lastError = new Error("empty_response");
								continue;
							}
							if (chatState) {
								chatState.lastCandidates = [
									{ key: issueKey, summary: "", score: 0 },
								];
								chatState.lastPrimaryKey = issueKey;
								chatState.lastUpdatedAt = Date.now();
							}
							if (memoryId) {
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "user",
									text,
								});
								void appendHistoryMessage(memoryId, {
									timestamp: new Date().toISOString(),
									role: "assistant",
									text: reply,
								});
							}
							await sendReply(reply);
							return;
						} catch (error) {
							lastError = error;
							logDebug("issue agent error", { ref, error: String(error) });
						}
					}
					setLogError(ctx, lastError ?? "unknown_error");
					await sendReply(`Ошибка: ${String(lastError ?? "unknown")}`);
					return;
				} catch (error) {
					setLogError(ctx, error);
					await sendReply(`Ошибка: ${String(error)}`);
					return;
				}
			}

			const modelRefs = [
				activeModelRef,
				...activeModelFallbacks.filter((ref) => ref !== activeModelRef),
			];
			let lastError: unknown = null;
			for (const ref of modelRefs) {
				const config = getModelConfig(ref);
				if (!config) {
					logDebug("model missing", { ref });
					continue;
				}
				try {
					setLogContext(ctx, { model_ref: ref, model_id: config.id });
					const plan = await buildOrchestrationPlan(text, ctx);
					const orchestrationPolicy = resolveOrchestrationPolicy(ctx);
					let orchestrationSummary = "";
					if (plan.agents.length > 0) {
						const allTools = await createAgentTools({
							history: historyText,
							chatId: memoryId,
							ctx,
						});
						const toolsByAgent = {
							tracker: buildTrackerTools(allTools),
							jira: buildJiraTools(allTools),
							posthog: buildPosthogTools(allTools),
							web: buildWebTools(allTools),
							memory: buildMemorySubagentTools(allTools),
						};
						const orchestrationResult = await runOrchestration(plan, {
							prompt: text,
							modelId: config.id,
							toolsByAgent,
							isGroupChat: isGroupChat(ctx),
							log: logger.info,
							allowAgents: orchestrationPolicy.allowAgents,
							denyAgents: orchestrationPolicy.denyAgents,
							budgets: orchestrationPolicy.budgets,
							parallelism: orchestrationPolicy.parallelism,
							agentOverrides: orchestrationPolicy.agentOverrides,
							defaultMaxSteps: orchestrationPolicy.defaultMaxSteps,
							defaultTimeoutMs: orchestrationPolicy.defaultTimeoutMs,
							hooks: orchestrationPolicy.hooks,
						});
						orchestrationSummary =
							buildOrchestrationSummary(orchestrationResult);
					}
					const mergedHistory = mergeHistoryBlocks(
						historyText,
						orchestrationSummary,
					);
					const agent = await createAgent(text, ref, config, {
						onCandidates: (candidates) => {
							if (!chatState) return;
							chatState.lastCandidates = candidates;
							chatState.lastPrimaryKey = candidates[0]?.key ?? null;
							chatState.lastUpdatedAt = Date.now();
						},
						recentCandidates: chatState?.lastCandidates,
						history: mergedHistory,
						chatId: memoryId,
						userName,
						onToolStep,
						ctx,
					});
					const result = await agent.generate({ prompt: text });
					clearAllStatuses();
					if (DEBUG_LOGS) {
						const steps =
							(
								result as {
									steps?: Array<{
										toolCalls?: Array<AgentToolCall>;
										toolResults?: Array<AgentToolResult>;
									}>;
								}
							).steps ?? [];
						const toolCalls = steps.flatMap((step) =>
							(step.toolCalls ?? [])
								.map((call) => call?.toolName)
								.filter((name): name is string => Boolean(name)),
						);
						const toolResults = steps.flatMap((step) =>
							(step.toolResults ?? [])
								.map((result) => result?.toolName)
								.filter((name): name is string => Boolean(name)),
						);
						logDebug("agent steps", {
							count: steps.length,
							toolCalls,
							toolResults,
							ref,
						});
					}
					const replyText = result.text?.trim();
					const sources = (result as { sources?: Array<{ url?: string }> })
						.sources;
					const reply = replyText
						? appendSources(replyText, sources)
						: replyText;
					if (!reply) {
						lastError = new Error("empty_response");
						continue;
					}
					if (memoryId) {
						void appendHistoryMessage(memoryId, {
							timestamp: new Date().toISOString(),
							role: "user",
							text,
						});
						void appendHistoryMessage(memoryId, {
							timestamp: new Date().toISOString(),
							role: "assistant",
							text: reply,
						});
					}
					await sendReply(reply);
					return;
				} catch (error) {
					lastError = error;
					logDebug("agent error", { ref, error: String(error) });
				}
			}
			setLogError(ctx, lastError ?? "unknown_error");
			await sendReply(`Ошибка: ${String(lastError ?? "unknown")}`);
		} catch (error) {
			clearAllStatuses();
			setLogError(ctx, error);
			await sendReply(`Ошибка: ${String(error)}`);
		}
	}

	bot.on("message", (ctx) => {
		setLogContext(ctx, { message_type: "other" });
		return sendText(
			ctx,
			"Попробуйте /tools, чтобы увидеть доступные инструменты.",
		);
	});

	const allowedUpdates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES];

	return { bot, allowedUpdates };
}
