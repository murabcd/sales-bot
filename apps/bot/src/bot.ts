import { openai } from "@ai-sdk/openai";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { PostHogAgentToolkit } from "@posthog/agent-toolkit/integrations/ai-sdk";
import {
	convertToModelMessages,
	type ToolLoopAgent,
	type ToolSet,
	experimental_transcribe as transcribe,
	type UIMessageChunk,
} from "ai";
import { regex } from "arkregex";
import { API_CONSTANTS, Bot, InlineKeyboard } from "grammy";
import {
	type AgentToolCall,
	type AgentToolResult,
	buildUserUIMessage,
	createAgentFactory,
	createAgentStreamWithTools,
	createAgentToolsFactory,
} from "./lib/agent/create.js";
import { createOrchestrationHelpers } from "./lib/agent/orchestration.js";
import {
	createIssueAgent,
	createMultiIssueAgent,
} from "./lib/agents/issue-agent.js";
import { runOrchestration } from "./lib/agents/orchestrator.js";
import {
	buildJiraTools,
	buildMemoryTools as buildMemorySubagentTools,
	buildPosthogTools,
	buildTrackerTools,
	buildWebTools,
} from "./lib/agents/subagents/index.js";
import { createAccessHelpers, isGroupChat } from "./lib/bot/access.js";
import { registerCommands } from "./lib/bot/commands.js";
import {
	createLogHelpers,
	createRequestLoggerMiddleware,
} from "./lib/bot/logging.js";
import { createTelegramHelpers } from "./lib/bot/telegram.js";
import type { BotContext } from "./lib/bot/types.js";
import {
	filterSkillsForChannel,
	isUserAllowedForChannel,
	parseChannelConfig,
	shouldRequireMentionForChannel,
} from "./lib/channels.js";
import { createFigmaClient } from "./lib/clients/figma.js";
import { createJiraClient } from "./lib/clients/jira.js";
import {
	createTrackerClient,
	extractCommentsText,
	type TrackerToolResult,
} from "./lib/clients/tracker.js";
import { createWikiClient } from "./lib/clients/wiki.js";
import { type BotEnv, loadBotEnv } from "./lib/config/env.js";
import { getChatState } from "./lib/context/chat-state.js";
import {
	appendHistoryMessage,
	clearHistoryMessages,
	formatHistoryForPrompt,
	loadHistoryMessages,
	setSupermemoryConfig,
} from "./lib/context/session-history.js";
import { type FilePart, isPdfDocument, toFilePart } from "./lib/files.js";
import { type ImageFilePart, toImageFilePart } from "./lib/images.js";
import { normalizeJiraIssue } from "./lib/jira.js";
import { createLogger } from "./lib/logger.js";
import {
	filterPosthogTools,
	POSTHOG_READONLY_TOOL_NAMES,
} from "./lib/posthog-tools.js";
import { extractIssueKeysFromText } from "./lib/text/normalize.js";
import { createToolStatusHandler } from "./lib/tool-status.js";
import { parseSenderToolAccess } from "./lib/tools/access.js";
import {
	createApprovalStore,
	listApprovals,
	parseApprovalList,
} from "./lib/tools/approvals.js";
import {
	filterToolMetasByPolicy,
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
import {
	type ModelsFile,
	normalizeModelRef,
	selectModel,
} from "./models-core.js";
import { type RuntimeSkill, resolveToolRef } from "./skills-core.js";

const TRACKER_URL_RE = regex.as(
	"https?://(?:www\\.)?tracker\\.yandex\\.ru/(?<key>[A-Z][A-Z0-9]+-\\d+)\\b",
	"gi",
);
const JIRA_URL_RE = regex.as(
	"https?://\\S+/browse/(?<key>[A-Z][A-Z0-9]+-\\d+)\\b",
	"gi",
);
const FIGMA_URL_RE = regex.as("https?://\\S*figma\\.com/(file|design)/", "i");
const ISSUE_KEY_RE = regex("\\b[A-Z]{2,10}-\\d+\\b", "g");

export type { BotEnv } from "./lib/config/env.js";

export type CreateBotOptions = {
	env: BotEnv;
	modelsConfig: ModelsFile;
	runtimeSkills?: RuntimeSkill[];
	getUptimeSeconds?: () => number;
	onDebugLog?: (line: string) => void;
	cronClient?: {
		list: (params?: {
			includeDisabled?: boolean;
		}) => Promise<{ jobs?: unknown[] }>;
		add: (params: Record<string, unknown>) => Promise<unknown>;
		remove: (params: { jobId: string }) => Promise<unknown>;
		run: (params: {
			jobId: string;
			mode?: "due" | "force";
		}) => Promise<unknown>;
	};
};

export async function createBot(options: CreateBotOptions) {
	const env = options.env;
	const envConfig = loadBotEnv(env);
	const {
		BOT_TOKEN,
		TRACKER_TOKEN,
		TRACKER_CLOUD_ORG_ID,
		TRACKER_ORG_ID,
		WIKI_TOKEN,
		WIKI_CLOUD_ORG_ID,
		FIGMA_TOKEN,
		JIRA_BASE_URL,
		JIRA_EMAIL,
		JIRA_API_TOKEN,
		JIRA_PROJECT_KEY,
		JIRA_BOARD_ID,
		POSTHOG_PERSONAL_API_KEY,
		POSTHOG_API_BASE_URL,
		OPENAI_API_KEY,
		OPENAI_MODEL,
		SOUL_PROMPT,
		ALLOWED_TG_IDS,
		CRON_STATUS_TIMEZONE,
		DEFAULT_TRACKER_QUEUE,
		DEFAULT_ISSUE_PREFIX,
		DEBUG_LOGS,
		TRACKER_API_BASE_URL,
		SUPERMEMORY_API_KEY,
		SUPERMEMORY_PROJECT_ID,
		SUPERMEMORY_TAG_PREFIX,
		HISTORY_MAX_MESSAGES,
		COMMENTS_CACHE_TTL_MS,
		COMMENTS_CACHE_MAX,
		COMMENTS_FETCH_CONCURRENCY,
		COMMENTS_FETCH_BUDGET_MS,
		TELEGRAM_TIMEOUT_SECONDS,
		TELEGRAM_TEXT_CHUNK_LIMIT,
		ALLOWED_TG_GROUPS,
		TELEGRAM_GROUP_REQUIRE_MENTION,
		IMAGE_MAX_BYTES,
		DOCUMENT_MAX_BYTES,
		WEB_SEARCH_ENABLED,
		WEB_SEARCH_CONTEXT_SIZE,
		TOOL_RATE_LIMITS,
		TOOL_APPROVAL_REQUIRED,
		TOOL_APPROVAL_TTL_MS,
		TOOL_APPROVAL_STORE_PATH,
		TOOL_ALLOWLIST_USER_IDS,
		TOOL_DENYLIST_USER_IDS,
		TOOL_ALLOWLIST_USER_TOOLS,
		TOOL_DENYLIST_USER_TOOLS,
		TOOL_ALLOWLIST_CHAT_TOOLS,
		TOOL_DENYLIST_CHAT_TOOLS,
		ORCHESTRATION_ALLOW_AGENTS,
		ORCHESTRATION_DENY_AGENTS,
		ORCHESTRATION_SUBAGENT_MAX_STEPS,
		ORCHESTRATION_SUBAGENT_MAX_TOOL_CALLS,
		ORCHESTRATION_SUBAGENT_TIMEOUT_MS,
		ORCHESTRATION_PARALLELISM,
		AGENT_DEFAULT_MAX_STEPS,
		AGENT_DEFAULT_TIMEOUT_MS,
		AGENT_CONFIG_OVERRIDES,
		SERVICE_NAME,
		RELEASE_VERSION,
		COMMIT_HASH,
		REGION,
		INSTANCE_ID,
	} = envConfig;
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
	const logger = createLogger({
		service: SERVICE_NAME,
		version: RELEASE_VERSION,
		commit_hash: COMMIT_HASH,
		region: REGION,
		instance_id: INSTANCE_ID,
	});

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
	const cronClient = options.cronClient;

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

		register(
			{
				name: "tracker_search",
				description: `Search Yandex Tracker issues in queue ${DEFAULT_TRACKER_QUEUE} using keywords from the question.`,
				source: "tracker",
				origin: "core",
			},
			agentTools,
		);

		register(
			{
				name: "google_public_doc_read",
				description: "Read a public Google Doc by shared link.",
				source: "web",
				origin: "google-public",
			},
			agentTools,
		);
		register(
			{
				name: "google_public_sheet_read",
				description: "Read a public Google Sheet by shared link.",
				source: "web",
				origin: "google-public",
			},
			agentTools,
		);

		if (FIGMA_TOKEN) {
			register(
				{
					name: "figma_me",
					description: "Get current Figma user profile.",
					source: "figma",
					origin: "figma",
				},
				agentTools,
			);
			register(
				{
					name: "figma_file_get",
					description: "Get Figma file metadata and document tree.",
					source: "figma",
					origin: "figma",
				},
				agentTools,
			);
			register(
				{
					name: "figma_file_nodes_get",
					description: "Get specific nodes from a Figma file.",
					source: "figma",
					origin: "figma",
				},
				agentTools,
			);
			register(
				{
					name: "figma_file_comments_list",
					description: "List comments for a Figma file.",
					source: "figma",
					origin: "figma",
				},
				agentTools,
			);
			register(
				{
					name: "figma_project_files_list",
					description: "List files in a Figma project.",
					source: "figma",
					origin: "figma",
				},
				agentTools,
			);
		}

		if (WIKI_TOKEN) {
			register(
				{
					name: "wiki_page_get",
					description: "Get Yandex Wiki page details by slug.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				agentTools,
			);
			register(
				{
					name: "wiki_page_get_by_id",
					description: "Get Yandex Wiki page details by id.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				agentTools,
			);
			register(
				{
					name: "wiki_page_create",
					description: "Create a new Yandex Wiki page.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				agentTools,
			);
			register(
				{
					name: "wiki_page_update",
					description: "Update an existing Yandex Wiki page.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				agentTools,
			);
			register(
				{
					name: "wiki_page_append_content",
					description: "Append content to an existing Yandex Wiki page.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				agentTools,
			);
		}

		if (options.cronClient) {
			register(
				{
					name: "cron_schedule",
					description:
						"Schedule a recurring report or reminder and deliver it to the current chat.",
					source: "cron",
					origin: "core",
				},
				agentTools,
			);
			register(
				{
					name: "cron_list",
					description: "List scheduled cron jobs.",
					source: "cron",
					origin: "core",
				},
				agentTools,
			);
			register(
				{
					name: "cron_remove",
					description: "Remove a scheduled cron job by id or name.",
					source: "cron",
					origin: "core",
				},
				agentTools,
			);
		}

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

	const { getLogContext, setLogContext, setLogError, getUpdateType, logDebug } =
		createLogHelpers({
			debugEnabled: DEBUG_LOGS,
			logger,
			onDebugLog: options.onDebugLog,
		});
	const { sendText, appendSources, createTextStream } = createTelegramHelpers({
		textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
		logDebug,
	});

	const trackerClient = createTrackerClient({
		token: TRACKER_TOKEN ?? "",
		cloudOrgId: TRACKER_CLOUD_ORG_ID,
		orgId: TRACKER_ORG_ID,
		apiBaseUrl: TRACKER_API_BASE_URL,
		commentsCacheTtlMs: COMMENTS_CACHE_TTL_MS,
		commentsCacheMax: COMMENTS_CACHE_MAX,
		commentsFetchConcurrency: COMMENTS_FETCH_CONCURRENCY,
		logger,
		getLogContext,
		setLogContext,
		logDebug,
	});
	const { trackerCallTool, trackerHealthCheck, getLastTrackerCallAt } =
		trackerClient;

	const wikiClient = createWikiClient({
		token: WIKI_TOKEN ?? "",
		apiBaseUrl: "https://api.wiki.yandex.net",
		cloudOrgId: WIKI_CLOUD_ORG_ID,
		logDebug,
	});
	const wikiEnabled = Boolean(WIKI_TOKEN);

	const figmaClient = createFigmaClient({
		token: FIGMA_TOKEN ?? "",
		apiBaseUrl: "https://api.figma.com",
		logDebug,
	});
	const figmaEnabled = Boolean(FIGMA_TOKEN);

	const jiraClient = createJiraClient({
		baseUrl: JIRA_BASE_URL,
		email: JIRA_EMAIL,
		apiToken: JIRA_API_TOKEN,
		commentsCacheTtlMs: COMMENTS_CACHE_TTL_MS,
		commentsCacheMax: COMMENTS_CACHE_MAX,
		commentsFetchConcurrency: COMMENTS_FETCH_CONCURRENCY,
		logDebug,
	});
	const { jiraIssueGet, jiraIssueGetComments } = jiraClient;
	const jiraEnabled = Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);

	bot.api.config.use(apiThrottler());
	bot.use(
		sequentialize((ctx) => {
			if (ctx.chat?.id) return `telegram:${ctx.chat.id}`;
			if (ctx.from?.id) return `telegram:user:${ctx.from.id}`;
			return "telegram:unknown";
		}),
	);

	bot.use(
		createRequestLoggerMiddleware({
			logger,
			getLogContext,
			setLogContext,
			setLogError,
			getUpdateType,
		}),
	);

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
	const {
		isGroupAllowed,
		isReplyToBotWithoutMention,
		isBotMentioned,
		shouldReplyAccessDenied,
	} = createAccessHelpers({ allowedGroups });

	bot.use((ctx, next) => {
		const raw = (ctx.update as { __channelConfig?: unknown }).__channelConfig;
		ctx.state.channelConfig = parseChannelConfig(raw);
		return next();
	});

	bot.use((ctx, next) => {
		const channelAllowlist = ctx.state.channelConfig?.allowUserIds ?? [];
		if (allowedIds.size === 0 && channelAllowlist.length === 0) return next();
		const userId = ctx.from?.id?.toString() ?? "";
		const allowed = isUserAllowedForChannel({
			userId,
			globalAllowlist: allowedIds,
			channelAllowlist,
		});
		if (!allowed) {
			setLogContext(ctx, {
				outcome: "blocked",
				status_code: 403,
			});
			if (shouldReplyAccessDenied(ctx)) {
				return sendText(ctx, "Доступ запрещен.");
			}
			return;
		}
		return next();
	});

	function resolveReasoningFor(config: typeof activeModelConfig): string {
		return activeReasoningOverride ?? config.reasoning ?? "standard";
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

	function startTypingHeartbeat(
		ctx: BotContext,
		options: { intervalMs?: number } = {},
	) {
		const intervalMs = options.intervalMs ?? 4500;
		let stopped = false;
		const tick = async () => {
			if (stopped) return;
			try {
				await ctx.replyWithChatAction("typing");
			} catch {
				// Ignore typing failures to avoid interrupting the run.
			}
		};
		void tick();
		const timer = setInterval(() => {
			void tick();
		}, intervalMs);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}

	function scheduleDelayedStatus(
		send: (message: string) => Promise<void> | void,
		message: string,
		delayMs: number,
	) {
		const timer = setTimeout(() => {
			void send(message);
		}, delayMs);
		return () => {
			clearTimeout(timer);
		};
	}
	const {
		buildOrchestrationPlan,
		buildOrchestrationSummary,
		mergeHistoryBlocks,
		resolveOrchestrationPolicy,
	} = createOrchestrationHelpers({
		allowAgentsRaw: ORCHESTRATION_ALLOW_AGENTS,
		denyAgentsRaw: ORCHESTRATION_DENY_AGENTS,
		subagentMaxSteps: ORCHESTRATION_SUBAGENT_MAX_STEPS,
		subagentMaxToolCalls: ORCHESTRATION_SUBAGENT_MAX_TOOL_CALLS,
		subagentTimeoutMs: ORCHESTRATION_SUBAGENT_TIMEOUT_MS,
		parallelism: ORCHESTRATION_PARALLELISM,
		agentConfigOverrides: AGENT_CONFIG_OVERRIDES,
		agentDefaultMaxSteps: AGENT_DEFAULT_MAX_STEPS,
		agentDefaultTimeoutMs: AGENT_DEFAULT_TIMEOUT_MS,
		logger,
		isGroupChat,
		getActiveModelId: () => activeModelConfig.id,
	});

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
	const createAgentTools = createAgentToolsFactory({
		toolConflictLogger,
		toolPolicy,
		resolveChatToolPolicy,
		toolRateLimiter,
		approvalRequired,
		approvalStore,
		senderToolAccess,
		logger,
		logDebug,
		debugLogs: DEBUG_LOGS,
		webSearchEnabled: WEB_SEARCH_ENABLED,
		webSearchContextSize: WEB_SEARCH_CONTEXT_SIZE,
		defaultTrackerQueue: DEFAULT_TRACKER_QUEUE,
		cronStatusTimezone: CRON_STATUS_TIMEZONE,
		jiraProjectKey: JIRA_PROJECT_KEY,
		jiraBoardId: JIRA_BOARD_ID,
		jiraEnabled,
		wikiEnabled,
		figmaEnabled,
		posthogPersonalApiKey: POSTHOG_PERSONAL_API_KEY,
		getPosthogTools,
		cronClient,
		trackerClient,
		wikiClient,
		figmaClient,
		jiraClient,
		logJiraAudit,
		supermemoryApiKey: SUPERMEMORY_API_KEY,
		supermemoryProjectId: SUPERMEMORY_PROJECT_ID,
		supermemoryTagPrefix: SUPERMEMORY_TAG_PREFIX,
		commentsFetchBudgetMs: COMMENTS_FETCH_BUDGET_MS,
	});

	const createAgent = createAgentFactory({
		getAgentTools,
		createAgentTools,
		resolveReasoningFor,
		logDebug,
		debugLogs: DEBUG_LOGS,
		webSearchEnabled: WEB_SEARCH_ENABLED,
		soulPrompt: SOUL_PROMPT,
	});

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
		const matches = Array.from(text.matchAll(ISSUE_KEY_RE)).map((match) =>
			match[0].toUpperCase(),
		);
		const unique = new Set(matches);
		return Array.from(unique);
	}

	function extractTrackerIssueKeysFromUrls(text: string): string[] {
		const matches = Array.from(text.matchAll(TRACKER_URL_RE))
			.map((match) => match.groups?.key ?? match[1])
			.filter((value): value is string => Boolean(value))
			.map((value) => value.toUpperCase());
		return Array.from(new Set(matches));
	}

	function extractJiraIssueKeysFromUrls(text: string): string[] {
		const matches = Array.from(text.matchAll(JIRA_URL_RE))
			.map((match) => match.groups?.key ?? match[1])
			.filter((value): value is string => Boolean(value))
			.map((value) => value.toUpperCase());
		return Array.from(new Set(matches));
	}

	function hasFigmaUrl(text: string): boolean {
		return FIGMA_URL_RE.test(text);
	}

	function isJiraIssueKey(key: string) {
		return key.startsWith(`${JIRA_PROJECT_KEY}-`);
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
		"Я Omni, персональный ассистент.\n" +
		"Помогу с задачами, аналитикой, могу искать в интернете.\n" +
		"Принимаю текст, голос, изображения и PDF.\n" +
		"Если есть номер задачи — укажите его, например PROJ-1234.\n\n";

	registerCommands({
		bot,
		startGreeting: START_GREETING,
		startKeyboard,
		sendText,
		logDebug,
		clearHistoryMessages,
		setLogContext,
		getCommandTools,
		resolveChatToolPolicy,
		toolPolicy,
		mergeToolPolicies,
		filterToolMetasByPolicy,
		TOOL_CONFLICTS,
		TOOL_SUPPRESSED_BY_POLICY,
		approvalRequired,
		approvalStore,
		listApprovals,
		parseToolRateLimits,
		TOOL_RATE_LIMITS,
		normalizeToolName,
		runtimeSkills,
		filterSkillsForChannel,
		resolveToolRef,
		trackerCallTool,
		formatToolResult,
		getActiveModelRef: () => activeModelRef,
		getActiveModelFallbacks: () => activeModelFallbacks,
		resolveReasoning,
		setActiveModel,
		setActiveReasoningOverride: (value) => {
			activeReasoningOverride = value;
		},
		normalizeModelRef,
		normalizeReasoning,
		modelsConfig,
		isGroupChat,
		shouldRequireMentionForChannel,
		isReplyToBotWithoutMention,
		isBotMentioned,
		TELEGRAM_GROUP_REQUIRE_MENTION,
		withTimeout,
		trackerHealthCheck,
		formatUptime,
		getUptimeSeconds: options.getUptimeSeconds,
		getLastTrackerCallAt,
		jiraEnabled,
		posthogEnabled: Boolean(POSTHOG_PERSONAL_API_KEY),
		webSearchEnabled: WEB_SEARCH_ENABLED,
		memoryEnabled: Boolean(SUPERMEMORY_API_KEY),
	});

	async function loadTelegramImageParts(
		ctx: BotContext,
	): Promise<ImageFilePart[]> {
		const photo = ctx.message?.photo?.at(-1);
		if (!photo?.file_id) return [];
		const file = await ctx.api.getFile(photo.file_id);
		if (!file.file_path) return [];
		const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`image_download_failed:${response.status}`);
		}
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > IMAGE_MAX_BYTES) {
			throw new Error(`image_too_large:${buffer.byteLength}`);
		}
		const [imagePart] = [
			toImageFilePart({
				buffer,
				contentType: response.headers.get("content-type"),
				filePath: file.file_path,
			}),
		];
		return imagePart ? [imagePart] : [];
	}

	async function loadTelegramPdfParts(ctx: BotContext): Promise<FilePart[]> {
		const document = ctx.message?.document;
		if (!document?.file_id) return [];
		const fileName = document.file_name;
		const isPdf = isPdfDocument({
			mimeType: document.mime_type,
			fileName,
		});
		if (!isPdf) return [];
		const file = await ctx.api.getFile(document.file_id);
		if (!file.file_path) return [];
		const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`document_download_failed:${response.status}`);
		}
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > DOCUMENT_MAX_BYTES) {
			throw new Error(`document_too_large:${buffer.byteLength}`);
		}
		const filename =
			fileName ?? file.file_path.split("/").pop() ?? "document.pdf";
		return [
			toFilePart({
				buffer,
				mediaType: "application/pdf",
				filename,
			}),
		];
	}

	type LocalChatOptions = {
		text: string;
		files?: FilePart[];
		webSearchEnabled?: boolean;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	};

	type LocalChatResult = {
		messages: string[];
	};

	type LocalChatStreamResult = {
		stream: ReadableStream<UIMessageChunk>;
	};

	async function runLocalChat(
		options: LocalChatOptions,
	): Promise<LocalChatResult> {
		const messages: string[] = [];
		const chatId = options.chatId ?? "admin";
		const userId = options.userId ?? "admin";
		const chatType = options.chatType ?? "private";
		const userName = options.userName ?? "Admin";
		const text = options.text.trim();
		const files = options.files ?? [];
		const webSearchEnabled = options.webSearchEnabled;
		if (!text && files.length === 0) return { messages };

		const ctx = {
			state: {},
			message: {
				text,
				message_id: 1,
			},
			chat: {
				id: chatId,
				type: chatType,
			},
			from: {
				id: userId,
				first_name: userName,
			},
			me: {
				id: "omni",
			},
			reply: async (replyText: string) => {
				messages.push(replyText);
			},
			replyWithChatAction: async () => {},
		} as unknown as BotContext;

		setLogContext(ctx, {
			request_id: `admin:${chatId}:${userId}:${Date.now()}`,
			chat_id: chatId,
			user_id: userId,
			username: userName,
			update_type: "admin",
			message_type: "text",
		});

		await handleIncomingText(ctx, text, files, webSearchEnabled);
		return { messages };
	}

	async function runLocalChatStream(
		options: LocalChatOptions,
		abortSignal?: AbortSignal,
	): Promise<LocalChatStreamResult> {
		const chatId = options.chatId ?? "admin";
		const userId = options.userId ?? "admin";
		const chatType = options.chatType ?? "private";
		const userName = options.userName ?? "Admin";
		const text = options.text.trim();
		const files = options.files ?? [];
		const webSearchEnabled = options.webSearchEnabled;
		if (!text && files.length === 0) {
			return { stream: createTextStream("Empty message.") };
		}

		const ctx = {
			state: {},
			message: {
				text,
				message_id: 1,
			},
			chat: {
				id: chatId,
				type: chatType,
			},
			from: {
				id: userId,
				first_name: userName,
			},
			me: {
				id: "omni",
			},
			replyWithChatAction: async () => {},
		} as unknown as BotContext;

		setLogContext(ctx, {
			request_id: `admin:${chatId}:${userId}:${Date.now()}`,
			chat_id: chatId,
			user_id: userId,
			username: userName,
			update_type: "admin",
			message_type: "text",
		});

		const stream = await handleIncomingTextStream(
			ctx,
			text,
			files,
			webSearchEnabled,
			abortSignal,
		);
		return { stream };
	}

	bot.on("message:text", async (ctx) => {
		setLogContext(ctx, { message_type: "text" });
		const text = ctx.message.text.trim();
		await handleIncomingText(ctx, text);
	});

	bot.on("message:photo", async (ctx) => {
		setLogContext(ctx, { message_type: "photo" });
		const caption = ctx.message.caption?.trim() ?? "";
		try {
			const files = await loadTelegramImageParts(ctx);
			await handleIncomingText(ctx, caption, files, undefined, true);
		} catch (error) {
			logDebug("photo handling error", { error: String(error) });
			setLogError(ctx, error);
			await sendText(ctx, `Ошибка: ${String(error)}`);
		}
	});

	bot.on("message:document", async (ctx) => {
		setLogContext(ctx, { message_type: "document" });
		const caption = ctx.message.caption?.trim() ?? "";
		try {
			const files = await loadTelegramPdfParts(ctx);
			if (files.length === 0) {
				await sendText(ctx, "Поддерживаются только PDF документы.");
				return;
			}
			await handleIncomingText(ctx, caption, files, undefined, true);
		} catch (error) {
			logDebug("document handling error", { error: String(error) });
			setLogError(ctx, error);
			await sendText(ctx, `Ошибка: ${String(error)}`);
		}
	});

	bot.on("message:voice", async (ctx) => {
		setLogContext(ctx, { message_type: "voice" });
		const voice = ctx.message.voice;
		if (!voice?.file_id) {
			await sendText(ctx, "Не удалось прочитать голосовое сообщение.");
			return;
		}
		const replyToMessageId = isGroupChat(ctx)
			? ctx.message?.message_id
			: undefined;
		const replyOptions = replyToMessageId
			? { reply_to_message_id: replyToMessageId }
			: undefined;
		const cancelStatus = scheduleDelayedStatus(
			(message) => sendText(ctx, message, replyOptions),
			"Обрабатываю голосовое сообщение…",
			2000,
		);
		try {
			if (!isGroupAllowed(ctx)) {
				cancelStatus();
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				if (shouldReplyAccessDenied(ctx)) {
					await sendText(ctx, "Доступ запрещен.");
				}
				return;
			}
			if (
				isGroupChat(ctx) &&
				shouldRequireMentionForChannel({
					channelConfig: ctx.state.channelConfig,
					defaultRequireMention: TELEGRAM_GROUP_REQUIRE_MENTION,
				})
			) {
				const allowReply = isReplyToBotWithoutMention(ctx);
				if (!allowReply && !isBotMentioned(ctx)) {
					cancelStatus();
					setLogContext(ctx, { outcome: "blocked", status_code: 403 });
					return;
				}
			}
			const file = await ctx.api.getFile(voice.file_id);
			if (!file.file_path) {
				cancelStatus();
				await sendText(ctx, "Не удалось получить файл голосового сообщения.");
				return;
			}
			const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
			const response = await fetch(downloadUrl);
			if (!response.ok) {
				cancelStatus();
				throw new Error(`audio_download_failed:${response.status}`);
			}
			const audio = new Uint8Array(await response.arrayBuffer());
			const transcript = await transcribe({
				model: openai.transcription("gpt-4o-mini-transcribe"),
				audio,
			});
			const text = transcript.text?.trim() ?? "";
			if (!text) {
				cancelStatus();
				await sendText(ctx, "Не удалось распознать речь в сообщении.");
				return;
			}
			cancelStatus();
			logDebug("voice transcript", { length: text.length });
			await handleIncomingText(ctx, text);
		} catch (error) {
			cancelStatus();
			logDebug("voice transcription error", { error: String(error) });
			setLogError(ctx, error);
			await sendText(ctx, `Ошибка: ${String(error)}`);
		}
	});

	async function handleIncomingText(
		ctx: BotContext,
		rawText: string,
		files: FilePart[] = [],
		webSearchEnabled?: boolean,
		skipFileStatus?: boolean,
	) {
		const text = rawText.trim();
		if (
			(!text && files.length === 0) ||
			(text.startsWith("/") && !files.length)
		) {
			return;
		}
		const replyToMessageId = isGroupChat(ctx)
			? ctx.message?.message_id
			: undefined;
		const replyOptions = replyToMessageId
			? { reply_to_message_id: replyToMessageId }
			: undefined;
		const sendReply = (message: string) => sendText(ctx, message, replyOptions);
		const { onToolStart, onToolStep, clearAllStatuses } =
			createToolStatusHandler(sendReply);
		let stopTyping: (() => void) | null = null;
		let cancelFileStatus: (() => void) | null = null;
		let processingTimer: ReturnType<typeof setTimeout> | null = null;
		const cancelProcessing = () => {
			if (processingTimer) {
				clearTimeout(processingTimer);
				processingTimer = null;
			}
		};
		const scheduleProcessing = () => {
			if (processingTimer) return;
			processingTimer = setTimeout(() => {
				void sendReply("Готовлю ответ…");
			}, 9000);
		};
		const handleToolStep = (toolNames: string[]) => {
			cancelProcessing();
			onToolStep?.(toolNames);
		};

		try {
			await ctx.replyWithChatAction("typing");
			if (!isGroupAllowed(ctx)) {
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				if (shouldReplyAccessDenied(ctx)) {
					await sendText(ctx, "Доступ запрещен.");
				}
				return;
			}
			if (
				isGroupChat(ctx) &&
				shouldRequireMentionForChannel({
					channelConfig: ctx.state.channelConfig,
					defaultRequireMention: TELEGRAM_GROUP_REQUIRE_MENTION,
				})
			) {
				const allowReply = isReplyToBotWithoutMention(ctx);
				if (!allowReply && !isBotMentioned(ctx)) {
					setLogContext(ctx, { outcome: "blocked", status_code: 403 });
					return;
				}
			}
			stopTyping = startTypingHeartbeat(ctx);
			scheduleProcessing();
			const chatId = ctx.chat?.id?.toString() ?? "";
			const memoryId = ctx.from?.id?.toString() ?? chatId;
			const userName = ctx.from?.first_name?.trim() || undefined;
			const chatState = chatId ? getChatState(chatId) : null;
			const promptText =
				text || (files.length > 0 ? "Analyze the attached file." : text);
			cancelFileStatus =
				!skipFileStatus && files.length > 0
					? scheduleDelayedStatus(sendReply, "Обрабатываю файл…", 2000)
					: null;
			const allowWebSearch =
				typeof webSearchEnabled === "boolean"
					? webSearchEnabled
					: WEB_SEARCH_ENABLED;
			const generateAgent = async (agent: ToolLoopAgent) => {
				if (files.length === 0) {
					return agent.generate({ prompt: promptText });
				}
				const messages = await convertToModelMessages([
					buildUserUIMessage(promptText, files),
				]);
				return agent.generate({ messages });
			};
			const historyMessages =
				memoryId && Number.isFinite(HISTORY_MAX_MESSAGES)
					? await loadHistoryMessages(
							memoryId,
							HISTORY_MAX_MESSAGES,
							promptText,
						)
					: [];
			const historyText = historyMessages.length
				? formatHistoryForPrompt(historyMessages)
				: "";
			const sprintQuery = isSprintQuery(promptText);
			const jiraKeysFromUrl = extractJiraIssueKeysFromUrls(promptText);
			const trackerKeysFromUrl = extractTrackerIssueKeysFromUrls(promptText);
			const urlIssueKeys = [...jiraKeysFromUrl, ...trackerKeysFromUrl];
			const issueKeys =
				hasFigmaUrl(promptText) && urlIssueKeys.length === 0
					? []
					: urlIssueKeys.length > 0
						? urlIssueKeys
						: sprintQuery
							? extractExplicitIssueKeys(promptText)
							: extractIssueKeysFromText(promptText, DEFAULT_ISSUE_PREFIX);
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
								jiraIssueGet(key, 8_000),
								jiraIssueGetComments({ issueKey: key }, 8_000),
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
								question: promptText,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issues: issuesData,
								userName,
								globalSoul: SOUL_PROMPT,
								channelSoul: ctx.state.channelConfig?.systemPrompt,
							});
							const result = await generateAgent(agent);
							cancelProcessing();
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
									text: promptText,
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
								trackerCallTool("issue_get", { issue_id: key }, 8_000, ctx),
								trackerCallTool(
									"issue_get_comments",
									{ issue_id: key },
									8_000,
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
								question: promptText,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issues: issuesData,
								userName,
								globalSoul: SOUL_PROMPT,
								channelSoul: ctx.state.channelConfig?.systemPrompt,
							});
							const result = await generateAgent(agent);
							cancelProcessing();
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
									text: promptText,
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
						jiraIssueGet(issueKey, 8_000),
						jiraIssueGetComments({ issueKey }, 8_000),
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
								question: promptText,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issueKey,
								issueText,
								commentsText,
								userName,
								globalSoul: SOUL_PROMPT,
								channelSoul: ctx.state.channelConfig?.systemPrompt,
							});
							const result = await generateAgent(agent);
							cancelProcessing();
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
									text: promptText,
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
						trackerCallTool("issue_get", { issue_id: issueKey }, 8_000, ctx),
						trackerCallTool(
							"issue_get_comments",
							{ issue_id: issueKey },
							8_000,
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
								question: promptText,
								modelRef: ref,
								modelName: config.label ?? config.id,
								reasoning: resolveReasoningFor(config),
								modelId: config.id,
								issueKey,
								issueText,
								commentsText,
								userName,
								globalSoul: SOUL_PROMPT,
								channelSoul: ctx.state.channelConfig?.systemPrompt,
							});
							const result = await generateAgent(agent);
							cancelProcessing();
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
									text: promptText,
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
					const plan = await buildOrchestrationPlan(promptText, ctx);
					const orchestrationPolicy = resolveOrchestrationPolicy(ctx);
					let orchestrationSummary = "";
					if (plan.agents.length > 0) {
						const allTools = await createAgentTools({
							history: historyText,
							chatId: memoryId,
							ctx,
							webSearchEnabled: allowWebSearch,
						});
						const toolsByAgent = {
							tracker: buildTrackerTools(allTools),
							jira: buildJiraTools(allTools),
							posthog: buildPosthogTools(allTools),
							web: buildWebTools(allTools),
							memory: buildMemorySubagentTools(allTools),
						};
						const orchestrationResult = await runOrchestration(plan, {
							prompt: promptText,
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
					const agent = await createAgent(promptText, ref, config, {
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
						onToolStart: (toolName) => {
							cancelProcessing();
							onToolStart?.(toolName);
						},
						onToolStep: handleToolStep,
						ctx,
						webSearchEnabled: allowWebSearch,
					});
					const result = await generateAgent(agent);
					cancelProcessing();
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
							text: promptText,
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
			cancelProcessing();
			clearAllStatuses();
			setLogError(ctx, error);
			await sendReply(`Ошибка: ${String(error)}`);
		} finally {
			cancelProcessing();
			clearAllStatuses();
			cancelFileStatus?.();
			stopTyping?.();
		}
	}

	async function handleIncomingTextStream(
		ctx: BotContext,
		rawText: string,
		files: FilePart[] = [],
		webSearchEnabled?: boolean,
		abortSignal?: AbortSignal,
	): Promise<ReadableStream<UIMessageChunk>> {
		const text = rawText.trim();
		if (
			(!text && files.length === 0) ||
			(text.startsWith("/") && !files.length)
		) {
			return createTextStream("Commands are not supported here.");
		}

		try {
			await ctx.replyWithChatAction("typing");
			if (!isGroupAllowed(ctx)) {
				setLogContext(ctx, { outcome: "blocked", status_code: 403 });
				if (shouldReplyAccessDenied(ctx)) {
					return createTextStream("Доступ запрещен.");
				}
				return createTextStream("");
			}
			if (
				isGroupChat(ctx) &&
				shouldRequireMentionForChannel({
					channelConfig: ctx.state.channelConfig,
					defaultRequireMention: TELEGRAM_GROUP_REQUIRE_MENTION,
				})
			) {
				const allowReply = isReplyToBotWithoutMention(ctx);
				if (!allowReply && !isBotMentioned(ctx)) {
					setLogContext(ctx, { outcome: "blocked", status_code: 403 });
					return createTextStream("Mention required.");
				}
			}
			const chatId = ctx.chat?.id?.toString() ?? "";
			const memoryId = ctx.from?.id?.toString() ?? chatId;
			const userName = ctx.from?.first_name?.trim() || undefined;
			const chatState = chatId ? getChatState(chatId) : null;
			const promptText =
				text || (files.length > 0 ? "Analyze the attached file." : text);
			const allowWebSearch =
				typeof webSearchEnabled === "boolean"
					? webSearchEnabled
					: WEB_SEARCH_ENABLED;
			const historyMessages =
				memoryId && Number.isFinite(HISTORY_MAX_MESSAGES)
					? await loadHistoryMessages(
							memoryId,
							HISTORY_MAX_MESSAGES,
							promptText,
						)
					: [];
			const historyText = historyMessages.length
				? formatHistoryForPrompt(historyMessages)
				: "";
			const sprintQuery = isSprintQuery(promptText);
			const jiraKeysFromUrl = extractJiraIssueKeysFromUrls(promptText);
			const trackerKeysFromUrl = extractTrackerIssueKeysFromUrls(promptText);
			const urlIssueKeys = [...jiraKeysFromUrl, ...trackerKeysFromUrl];
			const issueKeys =
				hasFigmaUrl(promptText) && urlIssueKeys.length === 0
					? []
					: urlIssueKeys.length > 0
						? urlIssueKeys
						: sprintQuery
							? extractExplicitIssueKeys(promptText)
							: extractIssueKeysFromText(promptText, DEFAULT_ISSUE_PREFIX);
			setLogContext(ctx, {
				issue_key_count: issueKeys.length,
				issue_key: issueKeys[0],
			});
			const jiraKeys = issueKeys.filter((key) => isJiraIssueKey(key));
			const trackerKeys = issueKeys.filter((key) => !isJiraIssueKey(key));

			if (issueKeys.length > 1 && jiraKeys.length === issueKeys.length) {
				const issuesData = await Promise.all(
					jiraKeys.slice(0, 5).map(async (key) => {
						const [issueResult, commentResult] = await Promise.all([
							jiraIssueGet(key, 8_000),
							jiraIssueGetComments({ issueKey: key }, 8_000),
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
				const config = getModelConfig(activeModelRef);
				if (!config) {
					return createTextStream("Model not configured.");
				}
				setLogContext(ctx, { model_ref: activeModelRef, model_id: config.id });
				const agent = await createMultiIssueAgent({
					question: promptText,
					modelRef: activeModelRef,
					modelName: config.label ?? config.id,
					reasoning: resolveReasoningFor(config),
					modelId: config.id,
					issues: issuesData,
					userName,
					globalSoul: SOUL_PROMPT,
					channelSoul: ctx.state.channelConfig?.systemPrompt,
				});
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
						text: promptText,
					});
				}
				return createAgentStreamWithTools(
					agent,
					promptText,
					files,
					undefined,
					abortSignal,
				);
			}

			if (issueKeys.length > 1 && trackerKeys.length === issueKeys.length) {
				const issuesData = await Promise.all(
					issueKeys.slice(0, 5).map(async (key) => {
						const [issueResult, commentResult] = await Promise.all([
							trackerCallTool("issue_get", { issue_id: key }, 8_000, ctx),
							trackerCallTool(
								"issue_get_comments",
								{ issue_id: key },
								8_000,
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
				const config = getModelConfig(activeModelRef);
				if (!config) {
					return createTextStream("Model not configured.");
				}
				setLogContext(ctx, { model_ref: activeModelRef, model_id: config.id });
				const agent = await createMultiIssueAgent({
					question: promptText,
					modelRef: activeModelRef,
					modelName: config.label ?? config.id,
					reasoning: resolveReasoningFor(config),
					modelId: config.id,
					issues: issuesData,
					userName,
					globalSoul: SOUL_PROMPT,
					channelSoul: ctx.state.channelConfig?.systemPrompt,
				});
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
						text: promptText,
					});
				}
				return createAgentStreamWithTools(
					agent,
					promptText,
					files,
					undefined,
					abortSignal,
				);
			}

			const issueKey = issueKeys[0] ?? null;
			if (issueKey && isJiraIssueKey(issueKey)) {
				const [issueResult, commentResult] = await Promise.all([
					jiraIssueGet(issueKey, 8_000),
					jiraIssueGetComments({ issueKey }, 8_000),
				]);
				const issueText = JSON.stringify(
					normalizeJiraIssue(issueResult),
					null,
					2,
				);
				const commentsText = commentResult.text;
				const config = getModelConfig(activeModelRef);
				if (!config) {
					return createTextStream("Model not configured.");
				}
				setLogContext(ctx, { model_ref: activeModelRef, model_id: config.id });
				const agent = await createIssueAgent({
					question: promptText,
					modelRef: activeModelRef,
					modelName: config.label ?? config.id,
					reasoning: resolveReasoningFor(config),
					modelId: config.id,
					issueKey,
					issueText,
					commentsText,
					userName,
					globalSoul: SOUL_PROMPT,
					channelSoul: ctx.state.channelConfig?.systemPrompt,
				});
				if (chatState) {
					chatState.lastCandidates = [{ key: issueKey, summary: "", score: 0 }];
					chatState.lastPrimaryKey = issueKey;
					chatState.lastUpdatedAt = Date.now();
				}
				if (memoryId) {
					void appendHistoryMessage(memoryId, {
						timestamp: new Date().toISOString(),
						role: "user",
						text: promptText,
					});
				}
				return createAgentStreamWithTools(
					agent,
					promptText,
					files,
					undefined,
					abortSignal,
				);
			}

			if (issueKey && trackerKeys.length === issueKeys.length) {
				const [issueResult, commentResult] = await Promise.all([
					trackerCallTool("issue_get", { issue_id: issueKey }, 8_000, ctx),
					trackerCallTool(
						"issue_get_comments",
						{ issue_id: issueKey },
						8_000,
						ctx,
					),
				]);
				const issueText = formatToolResult(issueResult);
				const commentsText = extractCommentsText(commentResult).text;
				const config = getModelConfig(activeModelRef);
				if (!config) {
					return createTextStream("Model not configured.");
				}
				setLogContext(ctx, { model_ref: activeModelRef, model_id: config.id });
				const agent = await createIssueAgent({
					question: promptText,
					modelRef: activeModelRef,
					modelName: config.label ?? config.id,
					reasoning: resolveReasoningFor(config),
					modelId: config.id,
					issueKey,
					issueText,
					commentsText,
					userName,
					globalSoul: SOUL_PROMPT,
					channelSoul: ctx.state.channelConfig?.systemPrompt,
				});
				if (chatState) {
					chatState.lastCandidates = [{ key: issueKey, summary: "", score: 0 }];
					chatState.lastPrimaryKey = issueKey;
					chatState.lastUpdatedAt = Date.now();
				}
				if (memoryId) {
					void appendHistoryMessage(memoryId, {
						timestamp: new Date().toISOString(),
						role: "user",
						text: promptText,
					});
				}
				return createAgentStreamWithTools(
					agent,
					promptText,
					files,
					undefined,
					abortSignal,
				);
			}

			const config = getModelConfig(activeModelRef);
			if (!config) {
				return createTextStream("Model not configured.");
			}
			setLogContext(ctx, { model_ref: activeModelRef, model_id: config.id });
			const plan = await buildOrchestrationPlan(promptText, ctx);
			const orchestrationPolicy = resolveOrchestrationPolicy(ctx);
			let orchestrationSummary = "";
			if (plan.agents.length > 0) {
				const allTools = await createAgentTools({
					history: historyText,
					chatId: memoryId,
					ctx,
					webSearchEnabled: allowWebSearch,
				});
				const toolsByAgent = {
					tracker: buildTrackerTools(allTools),
					jira: buildJiraTools(allTools),
					posthog: buildPosthogTools(allTools),
					web: buildWebTools(allTools),
					memory: buildMemorySubagentTools(allTools),
				};
				const orchestrationResult = await runOrchestration(plan, {
					prompt: promptText,
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
				orchestrationSummary = buildOrchestrationSummary(orchestrationResult);
			}
			const mergedHistory = mergeHistoryBlocks(
				historyText,
				orchestrationSummary,
			);
			const agent = await createAgent(promptText, activeModelRef, config, {
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
				ctx,
				webSearchEnabled: allowWebSearch,
			});
			if (memoryId) {
				void appendHistoryMessage(memoryId, {
					timestamp: new Date().toISOString(),
					role: "user",
					text: promptText,
				});
			}
			return createAgentStreamWithTools(
				agent,
				promptText,
				files,
				undefined,
				abortSignal,
			);
		} catch (error) {
			setLogError(ctx, error);
			return createTextStream(`Ошибка: ${String(error)}`);
		}
	}

	bot.on("message", (ctx) => {
		if (
			isGroupChat(ctx) &&
			shouldRequireMentionForChannel({
				channelConfig: ctx.state.channelConfig,
				defaultRequireMention: TELEGRAM_GROUP_REQUIRE_MENTION,
			})
		) {
			if (!isReplyToBotWithoutMention(ctx) && !isBotMentioned(ctx)) {
				return;
			}
		}
		if (
			ctx.message?.new_chat_members ||
			ctx.message?.left_chat_member ||
			ctx.message?.new_chat_title ||
			ctx.message?.new_chat_photo ||
			ctx.message?.delete_chat_photo ||
			ctx.message?.group_chat_created ||
			ctx.message?.supergroup_chat_created ||
			ctx.message?.channel_chat_created ||
			ctx.message?.message_auto_delete_timer_changed ||
			ctx.message?.pinned_message ||
			ctx.message?.migrate_from_chat_id ||
			ctx.message?.migrate_to_chat_id
		) {
			return;
		}
		setLogContext(ctx, { message_type: "other" });
		return sendText(
			ctx,
			"Попробуйте /tools, чтобы увидеть доступные инструменты.",
		);
	});

	const allowedUpdates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES];

	return { bot, allowedUpdates, runLocalChat, runLocalChatStream };
}
