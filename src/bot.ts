import { openai } from "@ai-sdk/openai";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { supermemoryTools } from "@supermemory/tools/ai-sdk";
import {
	stepCountIs,
	ToolLoopAgent,
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
import { type CandidateIssue, getChatState } from "./lib/context/chat-state.js";
import {
	appendHistoryMessage,
	clearHistoryMessages,
	formatHistoryForPrompt,
	loadHistoryMessages,
	setSupermemoryConfig,
} from "./lib/context/session-history.js";
import { createLogger } from "./lib/logger.js";
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
	const SESSION_DIR = env.SESSION_DIR ?? "data/sessions";
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
	const SERVICE_NAME = env.SERVICE_NAME ?? "omni";
	const RELEASE_VERSION = env.RELEASE_VERSION ?? env.APP_VERSION ?? undefined;
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

	const AGENT_TOOL_LIST = [
		{
			name: "tracker_search",
			description: `Search Yandex Tracker issues in queue ${DEFAULT_TRACKER_QUEUE} using keywords from the question.`,
		},
		...(WEB_SEARCH_ENABLED
			? [
					{
						name: "web_search",
						description:
							"Search the web for up-to-date information (OpenAI web_search).",
					},
				]
			: []),
	];
	const COMMAND_TOOL_LIST = [
		...AGENT_TOOL_LIST,
		{
			name: "issues_find",
			description: "Search issues using Yandex Tracker query language.",
		},
		{ name: "issue_get", description: "Get issue by key (e.g., PROJ-123)." },
		{
			name: "issue_get_comments",
			description: "Get comments for an issue by key.",
		},
		{ name: "issue_get_url", description: "Build public issue URL." },
	];
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
		return COMMAND_TOOL_LIST;
	}

	function createAgentTools(options?: {
		onCandidates?: (candidates: CandidateIssue[]) => void;
		recentCandidates?: CandidateIssue[];
		history?: string;
		chatId?: string;
		ctx?: BotContext;
	}) {
		const memoryTools = buildMemoryTools(options?.chatId);
		const webSearchContextSize = resolveWebSearchContextSize(
			WEB_SEARCH_CONTEXT_SIZE.trim().toLowerCase(),
		);
		return {
			...memoryTools,
			...(WEB_SEARCH_ENABLED
				? {
						web_search: openai.tools.webSearch({
							searchContextSize: webSearchContextSize,
						}),
					}
				: {}),
			tracker_search: tool({
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
		};
	}

	type AgentToolSet = ReturnType<typeof createAgentTools>;
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
		const agentTools = createAgentTools(options);
		return new ToolLoopAgent({
			model: openai(modelConfig.id),
			instructions,
			tools: agentTools,
			stopWhen: stepCountIs(6),
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
			clearHistoryMessages(SESSION_DIR, memoryId);
		}
		return sendText(ctx, START_GREETING, { reply_markup: startKeyboard });
	});

	async function handleHelp(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		await sendText(
			ctx,
			"Команды:\n" +
				"/tools - показать, какие инструменты Tracker доступны\n" +
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
			if (!tools.length) {
				await sendText(ctx, "Нет доступных инструментов Tracker.");
				return;
			}

			const lines = tools.map((tool) => {
				const desc = tool.description ? ` - ${tool.description}` : "";
				return `${tool.name}${desc}`;
			});

			await sendText(ctx, `Доступные инструменты:\n${lines.join("\n")}`);
		} catch (error) {
			await sendText(ctx, `Ошибка списка инструментов: ${String(error)}`);
		}
	}

	bot.command("tools", (ctx) => {
		setLogContext(ctx, { command: "/tools", message_type: "command" });
		return handleTools(ctx);
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

		text = text.replace(/```([\s\S]*?)```/g, (_match, code) => {
			const escaped = escapeHtml(String(code).trimEnd());
			const html = `<pre><code>${escaped}</code></pre>`;
			const token = `@@CODEBLOCK_${codeBlocks.length}@@`;
			codeBlocks.push(html);
			return token;
		});

		text = text.replace(/`([^`]+?)`/g, (_match, code) => {
			const escaped = escapeHtml(String(code));
			const html = `<code>${escaped}</code>`;
			const token = `@@INLINECODE_${inlineCodes.length}@@`;
			inlineCodes.push(html);
			return token;
		});

		text = escapeHtml(text);

		text = text.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
			(_match, label, url) => `<a href="${url}">${label}</a>`,
		);
		text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
		text = text.replace(/\*([^*]+)\*/g, "<i>$1</i>");
		text = text.replace(/_([^_]+)_/g, "<i>$1</i>");
		text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");

		text = text.replace(/@@INLINECODE_(\d+)@@/g, (_match, index) => {
			const entry = inlineCodes[Number(index)];
			return entry ?? "";
		});
		text = text.replace(/@@CODEBLOCK_(\d+)@@/g, (_match, index) => {
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
					? await loadHistoryMessages(
							SESSION_DIR,
							memoryId,
							HISTORY_MAX_MESSAGES,
							text,
						)
					: [];
			const historyText = historyMessages.length
				? formatHistoryForPrompt(historyMessages)
				: "";
			const issueKeys = extractIssueKeysFromText(text, DEFAULT_ISSUE_PREFIX);
			setLogContext(ctx, {
				issue_key_count: issueKeys.length,
				issue_key: issueKeys[0],
			});
			if (issueKeys.length > 1) {
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
								void appendHistoryMessage(SESSION_DIR, memoryId, {
									timestamp: new Date().toISOString(),
									role: "user",
									text,
								});
								void appendHistoryMessage(SESSION_DIR, memoryId, {
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
			if (issueKey) {
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
								void appendHistoryMessage(SESSION_DIR, memoryId, {
									timestamp: new Date().toISOString(),
									role: "user",
									text,
								});
								void appendHistoryMessage(SESSION_DIR, memoryId, {
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
					const agent = await createAgent(text, ref, config, {
						onCandidates: (candidates) => {
							if (!chatState) return;
							chatState.lastCandidates = candidates;
							chatState.lastPrimaryKey = candidates[0]?.key ?? null;
							chatState.lastUpdatedAt = Date.now();
						},
						recentCandidates: chatState?.lastCandidates,
						history: historyText,
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
						void appendHistoryMessage(SESSION_DIR, memoryId, {
							timestamp: new Date().toISOString(),
							role: "user",
							text,
						});
						void appendHistoryMessage(SESSION_DIR, memoryId, {
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
			"Попробуйте /tools, чтобы увидеть доступные инструменты Tracker.",
		);
	});

	const allowedUpdates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES];

	return { bot, allowedUpdates };
}
