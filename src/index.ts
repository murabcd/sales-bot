import fs from "node:fs";
import path from "node:path";
import { openai } from "@ai-sdk/openai";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import dotenv from "dotenv";
import { API_CONSTANTS, Bot, InlineKeyboard } from "grammy";
import { createRuntime } from "mcporter";
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
} from "./lib/context/session-history.js";
import { buildAgentInstructions } from "./lib/prompts/agent-instructions.js";
import {
	expandTermVariants,
	extractIssueKeysFromText,
	extractKeywords,
	normalizeForMatch,
} from "./lib/text/normalize.js";
import { loadModelsConfig, normalizeModelRef, selectModel } from "./models.js";
import { loadSkills, resolveToolRef } from "./skills.js";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const TRACKER_TOKEN = process.env.TRACKER_TOKEN;
const TRACKER_CLOUD_ORG_ID = process.env.TRACKER_CLOUD_ORG_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "";
const ALLOWED_TG_IDS = process.env.ALLOWED_TG_IDS ?? "";
const DEFAULT_TRACKER_QUEUE = process.env.DEFAULT_TRACKER_QUEUE ?? "PROJ";
const DEFAULT_ISSUE_PREFIX =
	process.env.DEFAULT_ISSUE_PREFIX ?? DEFAULT_TRACKER_QUEUE;
const DEBUG_LOGS = process.env.DEBUG_LOGS === "1";
const DEBUG_LOG_FILE = process.env.DEBUG_LOG_FILE ?? "";
const SESSION_DIR = process.env.SESSION_DIR ?? "data/sessions";
const HISTORY_MAX_MESSAGES = Number.parseInt(
	process.env.HISTORY_MAX_MESSAGES ?? "20",
	10,
);
const QUEUE_SCAN_MAX_PAGES = Number.parseInt(
	process.env.QUEUE_SCAN_MAX_PAGES ?? "5",
	10,
);
const COMMENTS_CACHE_TTL_MS = Number.parseInt(
	process.env.COMMENTS_CACHE_TTL_MS ?? "300000",
	10,
);
const COMMENTS_CACHE_MAX = Number.parseInt(
	process.env.COMMENTS_CACHE_MAX ?? "500",
	10,
);
const COMMENTS_FETCH_CONCURRENCY = Number.parseInt(
	process.env.COMMENTS_FETCH_CONCURRENCY ?? "4",
	10,
);
const COMMENTS_FETCH_BUDGET_MS = Number.parseInt(
	process.env.COMMENTS_FETCH_BUDGET_MS ?? "2500",
	10,
);

const commentsCache = new Map<
	string,
	{ at: number; value: { text: string; truncated: boolean } }
>();

const TELEGRAM_TIMEOUT_SECONDS = Number.parseInt(
	process.env.TELEGRAM_TIMEOUT_SECONDS ?? "60",
	10,
);
const TELEGRAM_TEXT_CHUNK_LIMIT = Number.parseInt(
	process.env.TELEGRAM_TEXT_CHUNK_LIMIT ?? "4000",
	10,
);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is unset");
if (!TRACKER_TOKEN) throw new Error("TRACKER_TOKEN is unset");
if (!TRACKER_CLOUD_ORG_ID) {
	throw new Error("TRACKER_CLOUD_ORG_ID is unset");
}
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is unset");
if (!ALLOWED_TG_IDS.trim()) {
	throw new Error("ALLOWED_TG_IDS must be set for production use");
}

const bot = new Bot(BOT_TOKEN, {
	client: {
		timeoutSeconds: Number.isFinite(TELEGRAM_TIMEOUT_SECONDS)
			? TELEGRAM_TIMEOUT_SECONDS
			: 60,
	},
});
const modelsConfig = await loadModelsConfig();
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
const runtime = await createRuntime({ configPath: "./config/mcporter.json" });
function resolveReasoning(): string {
	return activeReasoningOverride ?? activeModelConfig.reasoning ?? "standard";
}

const MCP_TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
let mcpToolsCache: {
	at: number;
	tools: Awaited<ReturnType<typeof mcpListTools>>;
} = { at: 0, tools: [] };
let lastMcpCallAt: number | null = null;
const runtimeSkills = await loadSkills();

function logDebug(message: string, data?: unknown) {
	if (!DEBUG_LOGS) return;
	if (data === undefined) {
		console.log(`[debug] ${message}`);
		return;
	}
	const pretty =
		typeof data === "string" ? data : JSON.stringify(data, null, 2);
	console.log(`[debug] ${message}\n${pretty}`);
	if (DEBUG_LOG_FILE) {
		try {
			const filePath = path.isAbsolute(DEBUG_LOG_FILE)
				? DEBUG_LOG_FILE
				: path.join(process.cwd(), DEBUG_LOG_FILE);
			fs.appendFileSync(filePath, `[debug] ${message}\n${pretty}\n`);
		} catch {
			// ignore log file errors to avoid breaking runtime
		}
	}
}

bot.api.config.use(apiThrottler());
bot.use(
	sequentialize((ctx) => {
		if (ctx.chat?.id) return `telegram:${ctx.chat.id}`;
		if (ctx.from?.id) return `telegram:user:${ctx.from.id}`;
		return "telegram:unknown";
	}),
);

const allowedIds = new Set(
	ALLOWED_TG_IDS.split(",")
		.map((value: string) => value.trim())
		.filter((value: string) => value.length > 0),
);

bot.use((ctx, next) => {
	if (allowedIds.size === 0) return next();
	const userId = ctx.from?.id?.toString() ?? "";
	if (!allowedIds.has(userId)) {
		return sendText(ctx, "Доступ запрещен.");
	}
	return next();
});

function resolveReasoningFor(config: typeof activeModelConfig): string {
	return activeReasoningOverride ?? config.reasoning ?? "standard";
}

function getModelConfig(ref: string) {
	return modelsConfig.models[ref];
}

function formatToolResult(result: McpToolResult): string {
	if (result.structuredContent) {
		try {
			return JSON.stringify(result.structuredContent, null, 2);
		} catch {
			return String(result.structuredContent);
		}
	}
	const textParts = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.filter((value) => value.trim().length > 0);
	return textParts.join("\n");
}

async function getCachedMcpTools() {
	const now = Date.now();
	if (
		now - mcpToolsCache.at < MCP_TOOL_CACHE_TTL_MS &&
		mcpToolsCache.tools.length
	) {
		return mcpToolsCache.tools;
	}
	try {
		const tools = await mcpListTools();
		mcpToolsCache = { at: now, tools };
		return tools;
	} catch {
		return mcpToolsCache.tools;
	}
}

async function createAgent(
	question: string,
	modelRef: string,
	modelConfig: typeof activeModelConfig,
	options?: {
		onCandidates?: (candidates: CandidateIssue[]) => void;
		recentCandidates?: CandidateIssue[];
		history?: string;
	},
) {
	const tools = await getCachedMcpTools();
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
	});
	return new ToolLoopAgent({
		model: openai(modelConfig.id),
		instructions,
		tools: {
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
					let queueScanPages = 0;
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
						const result = await mcpCallToolOnServer(
							"yandex-tracker",
							"issues_find",
							payload,
							30_000,
						);
						const normalized = normalizeIssuesResult(result);
						const keywords = extractKeywords(question, 12).map((item) =>
							item.toLowerCase(),
						);
						const mustInclude = extractMustIncludeKeywords(question).map(
							(item) => item.toLowerCase(),
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
								return matchesKeywords(haystack, keywords, mustInclude);
							});
							if (matches.length) {
								selected = matches;
								logDebug("tracker_search filtered", {
									total: top.length,
									matches: matches.length,
								});
							}
						}

						const needQueueScan =
							mustInclude.length > 0 &&
							!selected.some((entry) => {
								const summary = getIssueField(entry.issue, [
									"summary",
									"title",
								]);
								const description = getIssueField(entry.issue, ["description"]);
								const comments = entry.key
									? (commentsByIssue[entry.key]?.text ?? "")
									: "";
								const haystack = `${summary} ${description} ${comments}`;
								return matchesKeywords(haystack, mustInclude, mustInclude);
							});

						const queueScanMatches: RankedIssue[] = [];
						if (needQueueScan) {
							const fallbackPayload = {
								...payload,
								query: `Queue:${queueKey}`,
							};
							const maxPages = Number.isFinite(QUEUE_SCAN_MAX_PAGES)
								? Math.max(1, QUEUE_SCAN_MAX_PAGES)
								: 5;

							for (let page = 1; page <= maxPages; page += 1) {
								const pagedPayload = { ...fallbackPayload, page };
								logDebug("tracker_search queue_scan", pagedPayload);
								const pageResult = await mcpCallToolOnServer(
									"yandex-tracker",
									"issues_find",
									pagedPayload,
									30_000,
								);
								queueScanPages = page;
								const pageNormalized = normalizeIssuesResult(pageResult);
								const pageIssues = pageNormalized.issues;
								if (!pageIssues.length) break;
								const pageRanked = rankIssues(pageIssues, question);
								for (const entry of pageRanked) {
									if (!entry.key) continue;
									let commentText = commentsByIssue[entry.key]?.text ?? "";
									if (!commentText) {
										await fetchCommentsWithBudget(
											[entry.key],
											commentsByIssue,
											commentDeadline,
											commentStats,
										);
										commentText = commentsByIssue[entry.key]?.text ?? "";
									}
									const summary = getIssueField(entry.issue, [
										"summary",
										"title",
									]);
									const description = getIssueField(entry.issue, [
										"description",
									]);
									const haystack = `${summary} ${description} ${commentText}`;
									if (matchesKeywords(haystack, keywords, mustInclude)) {
										queueScanMatches.push(entry);
									}
								}
								if (queueScanMatches.length) break;
							}
						}

						if (queueScanMatches.length) {
							const seen = new Set(
								selected.map((item) => item.key).filter((key) => key),
							);
							if (mustInclude.length > 0) {
								selected = queueScanMatches;
							} else {
								selected = [
									...selected,
									...queueScanMatches.filter((item) => {
										if (!item.key) return false;
										if (seen.has(item.key)) return false;
										seen.add(item.key);
										return true;
									}),
								];
							}
							logDebug("tracker_search queue_matches", {
								matches: queueScanMatches.length,
								total: selected.length,
								keys: queueScanMatches
									.map((item) => item.key)
									.filter((key) => key),
							});
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
							queueScanPages,
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
			mcp_call: tool({
				description: "Call a Yandex Tracker MCP tool by name with JSON args.",
				inputSchema: z.object({
					tool: z.string().describe("Tool name, e.g. issues_find"),
					args: z.record(z.unknown()).optional().describe("Tool arguments"),
					server: z
						.string()
						.optional()
						.describe("Optional MCP server name, defaults to yandex-tracker"),
				}),
				execute: async ({ tool: toolName, args, server }) => {
					const toolRef = server ? `${server}.${toolName}` : toolName;
					const { server: resolvedServer, tool: resolvedTool } =
						resolveToolRef(toolRef);
					const requiredArgs: Record<string, string[]> = {
						issues_find: ["query"],
						issues_count: ["query"],
						issue_get: ["issue_id"],
						issue_get_comments: ["issue_id"],
						issue_get_links: ["issue_id"],
						issue_get_attachments: ["issue_id"],
						issue_get_checklist: ["issue_id"],
						issue_get_transitions: ["issue_id"],
						issue_execute_transition: ["issue_id", "transition_id"],
						issue_close: ["issue_id", "resolution_id"],
						issue_get_url: ["issue_id"],
						queue_get_tags: ["queue_id"],
						queue_get_versions: ["queue_id"],
						queue_get_fields: ["queue_id"],
						queue_get_metadata: ["queue_id"],
						user_get: ["user_id"],
					};
					const needed = requiredArgs[resolvedTool];
					const payload = (args ?? {}) as Record<string, unknown>;
					if (needed) {
						const missing = needed.filter(
							(key) => payload[key] === undefined || payload[key] === "",
						);
						if (missing.length) {
							return {
								error: "missing_required_params",
								tool: resolvedTool,
								missing,
							};
						}
					}
					logDebug("mcp_call", {
						server: resolvedServer,
						tool: resolvedTool,
						args: payload,
					});
					try {
						const result = await mcpCallToolOnServer(
							resolvedServer,
							resolvedTool,
							payload,
							30_000,
						);
						logDebug("mcp_call result", {
							server: resolvedServer,
							tool: resolvedTool,
						});
						return result;
					} catch (error) {
						logDebug("mcp_call error", { error: String(error) });
						return {
							error: String(error),
							server: resolvedServer,
							tool: resolvedTool,
						};
					}
				},
			}),
		},
		stopWhen: stepCountIs(6),
	});
}

function extractMustIncludeKeywords(text: string): string[] {
	void text;
	return [];
}

function matchesKeywords(
	text: string,
	keywords: string[],
	mustInclude: string[],
): boolean {
	const normalizedText = normalizeForMatch(text);
	const keywordMatch =
		keywords.length === 0 ||
		keywords.some((word) => normalizedText.includes(normalizeForMatch(word)));
	const requiredMatch =
		mustInclude.length === 0 ||
		mustInclude.every((word) =>
			normalizedText.includes(normalizeForMatch(word)),
		);
	return keywordMatch && requiredMatch;
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
				const commentResult = await mcpCallToolOnServer(
					"yandex-tracker",
					"issue_get_comments",
					{ issue_id: key },
					30_000,
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

function normalizeIssuesResult(result: McpToolResult): {
	issues: Array<Record<string, unknown>>;
} {
	const direct = result as unknown as {
		result?: Array<Record<string, unknown>>;
		issues?: Array<Record<string, unknown>>;
	};
	if (Array.isArray(direct.result)) return { issues: direct.result };
	if (Array.isArray(direct.issues)) return { issues: direct.issues };
	if (Array.isArray(result)) {
		return { issues: result as Array<Record<string, unknown>> };
	}
	if (result.structuredContent) {
		const structured = result.structuredContent as {
			result?: Array<Record<string, unknown>>;
			issues?: Array<Record<string, unknown>>;
		};
		const issues = structured.result ?? structured.issues ?? [];
		return { issues };
	}
	const textParts = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.filter((value) => value.trim().length > 0);
	const joined = textParts.join("\n");
	try {
		const parsed = JSON.parse(joined) as {
			result?: Array<Record<string, unknown>>;
			issues?: Array<Record<string, unknown>>;
		};
		const issues = parsed.result ?? parsed.issues ?? [];
		return { issues };
	} catch {
		const issues: Array<Record<string, unknown>> = [];
		for (const part of textParts) {
			try {
				const item = JSON.parse(part) as Record<string, unknown>;
				if (item && typeof item === "object") issues.push(item);
			} catch {
				// ignore non-JSON chunks
			}
		}
		return { issues };
	}
}

type RankedIssue = {
	issue: Record<string, unknown>;
	score: number;
	key: string | null;
	index: number;
};

function getIssueField(issue: Record<string, unknown>, keys: string[]): string {
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
	const summary = normalizeForMatch(getIssueField(issue, ["summary", "title"]));
	const description = normalizeForMatch(getIssueField(issue, ["description"]));
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

function extractCommentsText(result: McpToolResult): {
	text: string;
	truncated: boolean;
} {
	let comments: string[] = [];
	const direct = result as unknown as {
		result?: Array<Record<string, unknown>>;
	};
	if (Array.isArray(direct.result)) {
		comments = direct.result
			.map((item) => {
				const text =
					(item.text as string | undefined) ??
					(item.comment as string | undefined) ??
					(item.body as string | undefined);
				return typeof text === "string" ? text : "";
			})
			.filter((value) => value.length > 0);
	} else if (result.structuredContent) {
		const structured = result.structuredContent as {
			result?: Array<Record<string, unknown>>;
		};
		const raw = structured.result ?? [];
		comments = raw
			.map((item) => {
				const text =
					(item.text as string | undefined) ??
					(item.comment as string | undefined) ??
					(item.body as string | undefined);
				return typeof text === "string" ? text : "";
			})
			.filter((value) => value.length > 0);
	} else {
		const textParts = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.filter((value) => value.trim().length > 0);
		const joined = textParts.join("\n");
		try {
			const parsed = JSON.parse(joined) as {
				result?: Array<Record<string, unknown>>;
			};
			const raw = parsed.result ?? [];
			comments = raw
				.map((item) => {
					const text =
						(item.text as string | undefined) ??
						(item.comment as string | undefined) ??
						(item.body as string | undefined);
					return typeof text === "string" ? text : "";
				})
				.filter((value) => value.length > 0);
		} catch {
			const extracted: string[] = [];
			for (const part of textParts) {
				try {
					const item = JSON.parse(part) as Record<string, unknown>;
					const text =
						(item.text as string | undefined) ??
						(item.comment as string | undefined) ??
						(item.body as string | undefined);
					if (typeof text === "string" && text.length > 0) {
						extracted.push(text);
					}
				} catch {
					// ignore non-JSON chunks
				}
			}
			comments = extracted;
		}
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

type McpToolResult = {
	structuredContent?: unknown;
	content: Array<{ type: string; text?: string }>;
};

async function mcpCallTool<T = McpToolResult>(
	toolName: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<T> {
	return mcpCallToolOnServer("yandex-tracker", toolName, args, timeoutMs);
}

async function mcpCallToolOnServer<T = McpToolResult>(
	server: string,
	toolName: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<T> {
	lastMcpCallAt = Date.now();
	return runtime.callTool(server, toolName, {
		args,
		timeoutMs,
	}) as Promise<T>;
}

async function mcpListTools(): Promise<
	Awaited<ReturnType<typeof runtime.listTools>>
> {
	return runtime.listTools("yandex-tracker");
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
	"Я ассистент по Yandex Tracker\n\n" +
	"Задайте вопрос обычным текстом — отвечу по задаче, статусу или итогам\n\n" +
	"Если есть номер задачи, укажите его, например PROJ-1234";

bot.command("start", (ctx) => {
	const chatId = ctx.chat?.id?.toString() ?? ctx.from?.id?.toString() ?? "";
	if (chatId) {
		clearHistoryMessages(SESSION_DIR, chatId);
	}
	return sendText(ctx, START_GREETING, { reply_markup: startKeyboard });
});

async function handleHelp(ctx: { reply: (text: string) => Promise<unknown> }) {
	await sendText(
		ctx,
		"Команды:\n" +
			"/tools - список MCP инструментов Yandex Tracker\n" +
			"/model - текущая модель (list|set <ref>)\n" +
			"/model reasoning off|low|standard|high\n" +
			"/tracker <tool> <json> - вызвать инструмент с JSON аргументами\n\n" +
			"Можно просто спросить, например:\n" +
			'"Делали интеграцию с ЦИАН?"',
	);
}

bot.command("help", (ctx) => handleHelp(ctx));

async function handleTools(ctx: { reply: (text: string) => Promise<unknown> }) {
	try {
		const tools = await mcpListTools();
		if (!tools.length) {
			await sendText(ctx, "Нет доступных инструментов MCP.");
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

bot.command("tools", (ctx) => handleTools(ctx));

bot.command("model", async (ctx) => {
	const text = ctx.message?.text ?? "";
	const [, sub, ...rest] = text.split(" ");

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
			await sendText(ctx, "Использование: /model set <ref> [reasoning]");
			return;
		}
		const [refPart, reasoningPart] = raw.split(/\s+/);
		const normalized = normalizeModelRef(refPart ?? "");
		if (!modelsConfig.models[normalized]) {
			await sendText(ctx, `Неизвестная модель: ${normalized}`);
			return;
		}
		setActiveModel(normalized);
		if (reasoningPart) {
			const normalizedReasoning = normalizeReasoning(reasoningPart);
			if (!normalizedReasoning) {
				await sendText(
					ctx,
					"Неверный reasoning. Используйте: off | low | standard | high",
				);
				return;
			}
			activeReasoningOverride = normalizedReasoning;
		}
		await sendText(ctx, `Model set: ${activeModelRef}`);
		return;
	}

	if (sub === "reasoning") {
		const raw = rest.join(" ").trim();
		if (!raw) {
			await sendText(
				ctx,
				`Reasoning: ${resolveReasoning()}\nИспользование: /model reasoning <off|low|standard|high>`,
			);
			return;
		}
		const normalizedReasoning = normalizeReasoning(raw);
		if (!normalizedReasoning) {
			await sendText(
				ctx,
				"Неверный reasoning. Используйте: off | low | standard | high",
			);
			return;
		}
		activeReasoningOverride = normalizedReasoning;
		await sendText(ctx, `Reasoning set: ${activeReasoningOverride}`);
		return;
	}

	await sendText(ctx, "Команды: /model, /model list, /model set <ref>");
});

async function handleSkills(ctx: {
	reply: (text: string) => Promise<unknown>;
}) {
	if (!runtimeSkills.length) {
		await sendText(ctx, "Нет доступных runtime-skills.");
		return;
	}
	const lines = runtimeSkills.map((skill) => {
		const desc = skill.description ? ` - ${skill.description}` : "";
		return `${skill.name}${desc}`;
	});
	await sendText(ctx, `Доступные runtime-skills:\n${lines.join("\n")}`);
}

bot.command("skills", (ctx) => handleSkills(ctx));

bot.command("skill", async (ctx) => {
	const text = ctx.message?.text ?? "";
	const [, skillName, ...rest] = text.split(" ");
	if (!skillName) {
		await sendText(ctx, "Использование: /skill <name> <json>");
		return;
	}
	const skill = runtimeSkills.find((item) => item.name === skillName);
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

	try {
		const result = await mcpCallToolOnServer(
			server,
			tool,
			mergedArgs,
			skill.timeoutMs ?? 30_000,
		);

		if (result.structuredContent) {
			await sendText(ctx, JSON.stringify(result.structuredContent, null, 2));
			return;
		}

		const textParts = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text);

		if (textParts.length) {
			await sendText(ctx, textParts.join("\n"));
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
	const uptime = formatUptime(process.uptime());
	let mcpStatus = "ok";
	let mcpInfo = "";
	try {
		const tools = await withTimeout(mcpListTools(), 5_000, "mcpListTools");
		mcpInfo = `tools=${tools.length}`;
	} catch (error) {
		mcpStatus = "error";
		mcpInfo = String(error);
	}

	const lastCall = lastMcpCallAt
		? new Date(lastMcpCallAt).toISOString()
		: "n/a";
	await sendText(
		ctx,
		[
			"Status:",
			`uptime: ${uptime}`,
			`model: ${activeModelRef}`,
			`mcp: ${mcpStatus} (${mcpInfo})`,
			`last_mcp_call: ${lastCall}`,
		].join("\n"),
	);
}

bot.command("status", (ctx) => handleStatus(ctx));

bot.callbackQuery(/^cmd:(help|status)$/, async (ctx) => {
	await ctx.answerCallbackQuery();
	const command = ctx.match?.[1];
	if (command === "help") {
		await handleHelp(ctx);
		return;
	}
	if (command === "status") {
		await handleStatus(ctx);
	}
});

bot.command("tracker", async (ctx) => {
	const text = ctx.message?.text ?? "";
	const [, toolName, ...rest] = text.split(" ");
	if (!toolName) {
		await sendText(ctx, "Использование: /tracker <tool> <json>");
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
		const result = await mcpCallTool(toolName, args, 30_000);

		if (result.structuredContent) {
			await sendText(ctx, JSON.stringify(result.structuredContent, null, 2));
			return;
		}

		const textParts = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text);

		if (textParts.length) {
			await sendText(ctx, textParts.join("\n"));
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
		Number.isFinite(TELEGRAM_TEXT_CHUNK_LIMIT) && TELEGRAM_TEXT_CHUNK_LIMIT > 0
			? TELEGRAM_TEXT_CHUNK_LIMIT
			: 4000;
	if (text.length <= limit) {
		await ctx.reply(text, options);
		return;
	}
	for (let i = 0; i < text.length; i += limit) {
		const chunk = text.slice(i, i + limit);
		await ctx.reply(chunk, options);
	}
}

bot.on("message:text", async (ctx) => {
	const text = ctx.message.text.trim();
	if (!text || text.startsWith("/")) {
		return;
	}

	try {
		await ctx.replyWithChatAction("typing");
		const chatId = ctx.chat?.id?.toString() ?? ctx.from?.id?.toString() ?? "";
		const chatState = chatId ? getChatState(chatId) : null;
		const historyMessages =
			chatId && Number.isFinite(HISTORY_MAX_MESSAGES)
				? loadHistoryMessages(SESSION_DIR, chatId, HISTORY_MAX_MESSAGES)
				: [];
		const historyText = historyMessages.length
			? formatHistoryForPrompt(historyMessages)
			: "";
		const issueKeys = extractIssueKeysFromText(text, DEFAULT_ISSUE_PREFIX);
		if (issueKeys.length > 1) {
			try {
				const issuesData: Array<{
					key: string;
					issueText: string;
					commentsText: string;
				}> = [];
				for (const key of issueKeys.slice(0, 5)) {
					const issueResult = await mcpCallToolOnServer(
						"yandex-tracker",
						"issue_get",
						{ issue_id: key },
						30_000,
					);
					const commentResult = await mcpCallToolOnServer(
						"yandex-tracker",
						"issue_get_comments",
						{ issue_id: key },
						30_000,
					);
					issuesData.push({
						key,
						issueText: formatToolResult(issueResult),
						commentsText: extractCommentsText(commentResult).text,
					});
				}
				const modelRefs = [
					activeModelRef,
					...activeModelFallbacks.filter((ref) => ref !== activeModelRef),
				];
				let lastError: unknown = null;
				for (const ref of modelRefs) {
					const config = getModelConfig(ref);
					if (!config) continue;
					try {
						const agent = await createMultiIssueAgent({
							question: text,
							modelRef: ref,
							modelName: config.label ?? config.id,
							reasoning: resolveReasoningFor(config),
							modelId: config.id,
							issues: issuesData,
						});
						const result = await agent.generate({ prompt: text });
						const reply = result.text?.trim();
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
						if (chatId) {
							appendHistoryMessage(SESSION_DIR, chatId, {
								timestamp: new Date().toISOString(),
								role: "user",
								text,
							});
							appendHistoryMessage(SESSION_DIR, chatId, {
								timestamp: new Date().toISOString(),
								role: "assistant",
								text: reply,
							});
						}
						await sendText(ctx, reply);
						return;
					} catch (error) {
						lastError = error;
						logDebug("multi issue agent error", {
							ref,
							error: String(error),
						});
					}
				}
				await sendText(ctx, `Ошибка: ${String(lastError ?? "unknown")}`);
				return;
			} catch (error) {
				await sendText(ctx, `Ошибка: ${String(error)}`);
				return;
			}
		}

		const issueKey = issueKeys[0] ?? null;
		if (issueKey) {
			try {
				const issueResult = await mcpCallToolOnServer(
					"yandex-tracker",
					"issue_get",
					{ issue_id: issueKey },
					30_000,
				);
				const commentResult = await mcpCallToolOnServer(
					"yandex-tracker",
					"issue_get_comments",
					{ issue_id: issueKey },
					30_000,
				);
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
						const agent = await createIssueAgent({
							question: text,
							modelRef: ref,
							modelName: config.label ?? config.id,
							reasoning: resolveReasoningFor(config),
							modelId: config.id,
							issueKey,
							issueText,
							commentsText,
						});
						const result = await agent.generate({ prompt: text });
						const reply = result.text?.trim();
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
						if (chatId) {
							appendHistoryMessage(SESSION_DIR, chatId, {
								timestamp: new Date().toISOString(),
								role: "user",
								text,
							});
							appendHistoryMessage(SESSION_DIR, chatId, {
								timestamp: new Date().toISOString(),
								role: "assistant",
								text: reply,
							});
						}
						await sendText(ctx, reply);
						return;
					} catch (error) {
						lastError = error;
						logDebug("issue agent error", { ref, error: String(error) });
					}
				}
				await sendText(ctx, `Ошибка: ${String(lastError ?? "unknown")}`);
				return;
			} catch (error) {
				await sendText(ctx, `Ошибка: ${String(error)}`);
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
				const agent = await createAgent(text, ref, config, {
					onCandidates: (candidates) => {
						if (!chatState) return;
						chatState.lastCandidates = candidates;
						chatState.lastPrimaryKey = candidates[0]?.key ?? null;
						chatState.lastUpdatedAt = Date.now();
					},
					recentCandidates: chatState?.lastCandidates,
					history: historyText,
				});
				const result = await agent.generate({ prompt: text });
				if (DEBUG_LOGS) {
					const steps =
						(
							result as {
								steps?: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
							}
						).steps ?? [];
					const toolCalls = steps.flatMap((step) =>
						(step.toolCalls ?? [])
							.map((call) => call.toolName)
							.filter((name): name is string => Boolean(name)),
					);
					logDebug("agent steps", { count: steps.length, toolCalls, ref });
				}
				const reply = result.text?.trim();
				if (!reply) {
					lastError = new Error("empty_response");
					continue;
				}
				if (chatId) {
					appendHistoryMessage(SESSION_DIR, chatId, {
						timestamp: new Date().toISOString(),
						role: "user",
						text,
					});
					appendHistoryMessage(SESSION_DIR, chatId, {
						timestamp: new Date().toISOString(),
						role: "assistant",
						text: reply,
					});
				}
				await sendText(ctx, reply);
				return;
			} catch (error) {
				lastError = error;
				logDebug("agent error", { ref, error: String(error) });
			}
		}
		await sendText(ctx, `Ошибка: ${String(lastError ?? "unknown")}`);
	} catch (error) {
		await sendText(ctx, `Ошибка: ${String(error)}`);
	}
});

bot.on("message", (ctx) =>
	sendText(
		ctx,
		"Попробуйте /tools, чтобы увидеть доступные инструменты Tracker.",
	),
);

process.once("SIGINT", () => {
	bot.stop();
	void runtime.close();
});
process.once("SIGTERM", () => {
	bot.stop();
	void runtime.close();
});

const allowedUpdates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES];
bot.start({ allowed_updates: allowedUpdates });
