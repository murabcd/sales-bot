import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { supermemoryTools } from "@supermemory/tools/ai-sdk";
import {
	createAgentUIStream,
	createUIMessageStream,
	generateText,
	type LanguageModel,
	type ModelMessage,
	stepCountIs,
	ToolLoopAgent,
	type ToolSet,
	type TypedToolCall,
	type TypedToolResult,
	tool,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import { regex } from "arkregex";
import { z } from "zod";
import type { ModelConfig } from "../../models-core.js";
import type { RuntimeSkill } from "../../skills-core.js";
import {
	buildCronExpr,
	findCronJob,
	formatCronJob,
	parseTime,
} from "../bot/cron.js";
import type { BotContext } from "../bot/types.js";
import type { ChannelConfig } from "../channels.js";
import type { FigmaClient } from "../clients/figma.js";
import type { JiraClient } from "../clients/jira.js";
import type { TrackerClient } from "../clients/tracker.js";
import {
	buildIssuesQuery,
	getIssueField,
	matchesKeywords,
	normalizeIssuesResult,
	rankIssues,
} from "../clients/tracker.js";
import type { WikiClient } from "../clients/wiki.js";
import { type FilePart, toFilePart } from "../files.js";
import type { ImageStore } from "../image-store.js";
import { buildJiraJql, normalizeJiraIssue } from "../jira.js";
import { buildAgentInstructions } from "../prompts/agent-instructions.js";
import { buildSkillsPrompt } from "../prompts/skills-prompt.js";
import { formatUserDateTime } from "../prompts/time.js";
import { extractKeywords } from "../text/normalize.js";
import {
	isToolAllowedForSender,
	type SenderToolAccess,
} from "../tools/access.js";
import type { ApprovalStore } from "../tools/approvals.js";
import { wrapToolMapWithHooks } from "../tools/hooks.js";
import {
	filterToolMapByPolicy,
	isToolAllowed,
	type ToolPolicy,
} from "../tools/policy.js";
import {
	createToolRegistry,
	normalizeToolName,
	type ToolConflictLog,
	type ToolMeta,
} from "../tools/registry.js";
import { sanitizeToolCallIdsForTranscript } from "../tools/tool-call-id.js";
import { repairToolUseResultPairing } from "../tools/transcript-repair.js";

export type AgentToolSet = Awaited<ReturnType<AgentToolsFactory>>;
export type AgentToolCall = TypedToolCall<AgentToolSet>;
export type AgentToolResult = TypedToolResult<AgentToolSet>;

export type ToolConflictLogger = (event: ToolConflictLog) => void;

const GEMINI_IMAGE_MODEL_ID = "gemini-3-pro-image-preview";
const GEMINI_IMAGE_ASPECT_RATIOS = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
] as const;

const WIKI_NUMERIC_ID_RE = regex("^\\d+$");
const WIKI_PATH_LEADING_SLASH_RE = regex("^/+");
const WIKI_PATH_TRAILING_SLASH_RE = regex("/+$");

function resolveImageExtension(mediaType: string): string {
	switch (mediaType) {
		case "image/jpeg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

function decodeBase64Payload(base64: string): Uint8Array | null {
	const trimmed = base64.trim();
	if (!trimmed) return null;
	const payload = trimmed.startsWith("data:")
		? trimmed.slice(trimmed.indexOf(",") + 1)
		: trimmed;
	if (!payload) return null;
	try {
		return new Uint8Array(Buffer.from(payload, "base64"));
	} catch {
		return null;
	}
}

type Logger = {
	info: (payload: Record<string, unknown>) => void;
};

type ToolRateLimiter = {
	check: (
		tool: string,
		chatId?: string,
		userId?: string,
	) => { allowed: boolean; resetMs: number };
};

export type AgentToolsFactory = (
	options?: CreateAgentToolsOptions,
) => Promise<ToolSet>;

export type CreateAgentToolsOptions = {
	onCandidates?: (candidates: CandidateIssue[]) => void;
	recentCandidates?: CandidateIssue[];
	history?: string;
	chatId?: string;
	ctx?: BotContext;
	webSearchEnabled?: boolean;
	onToolStart?: (toolName: string) => void;
};

export type CandidateIssue = {
	key: string | null;
	summary: string;
	score: number;
};

export type AgentToolsDeps = {
	toolConflictLogger: ToolConflictLogger;
	toolPolicy: ToolPolicy | undefined;
	resolveChatToolPolicy: (ctx?: BotContext) => ToolPolicy | undefined;
	toolRateLimiter: ToolRateLimiter;
	approvalRequired: Set<string>;
	approvalStore: ApprovalStore;
	senderToolAccess: SenderToolAccess;
	logger: Logger;
	logDebug: (event: string, payload?: Record<string, unknown>) => void;
	debugLogs: boolean;
	webSearchEnabled: boolean;
	webSearchContextSize: string;
	defaultTrackerQueue: string;
	cronStatusTimezone: string;
	resolveChatTimezone?: (
		ctx?: BotContext,
		chatId?: string,
	) => Promise<string | undefined> | string | undefined;
	jiraProjectKey: string;
	jiraBoardId: number;
	jiraEnabled: boolean;
	wikiEnabled: boolean;
	figmaEnabled: boolean;
	posthogPersonalApiKey: string;
	getPosthogTools: () => Promise<ToolSet>;
	geminiApiKey: string;
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
		update: (params: {
			id?: string;
			jobId?: string;
			patch: Record<string, unknown>;
		}) => Promise<unknown>;
		runs: (params: {
			id?: string;
			jobId?: string;
			limit?: number;
		}) => Promise<unknown>;
		status: () => Promise<unknown>;
	};
	trackerClient: TrackerClient;
	wikiClient: WikiClient;
	figmaClient: FigmaClient;
	jiraClient: JiraClient;
	logJiraAudit: (
		ctx: BotContext | undefined,
		toolName: string,
		args: Record<string, unknown>,
		outcome: "success" | "error",
		error?: string,
		durationMs?: number,
	) => void;
	supermemoryApiKey: string;
	supermemoryProjectId: string;
	supermemoryTagPrefix: string;
	commentsFetchBudgetMs: number;
	imageStore?: ImageStore;
	geminiImageSize?: "1K" | "2K" | "4K";
};

export type AgentModelConfig = ModelConfig;

export type CreateAgentOptions = {
	onCandidates?: (candidates: CandidateIssue[]) => void;
	recentCandidates?: CandidateIssue[];
	history?: string;
	chatId?: string;
	userName?: string;
	onToolStep?: (toolNames: string[]) => Promise<void> | void;
	onToolStart?: (toolName: string) => void;
	ctx?: BotContext;
	webSearchEnabled?: boolean;
	promptMode?: "full" | "minimal" | "none";
};

export type AgentDeps = {
	getAgentTools: () => Promise<ToolMeta[]>;
	createAgentTools: AgentToolsFactory;
	resolveReasoningFor: (config: ModelConfig) => string;
	logDebug: (event: string, payload?: Record<string, unknown>) => void;
	debugLogs: boolean;
	webSearchEnabled: boolean;
	soulPrompt: string;
	projectContext?: Array<{ path: string; content: string }>;
	runtimeSkills?: RuntimeSkill[];
	filterSkillsForChannel?: (params: {
		skills: RuntimeSkill[];
		channelConfig?: ChannelConfig;
	}) => RuntimeSkill[];
	resolveChatTimezone?: (
		ctx?: BotContext,
		chatId?: string,
	) => Promise<string> | string;
	serviceName?: string;
	releaseVersion?: string;
	region?: string;
	instanceId?: string;
};

// buildSkillsPrompt and formatUserDateTime moved to prompts helpers

function resolveWebSearchContextSize(value: string): "low" | "medium" | "high" {
	if (value === "medium" || value === "high") return value;
	return "low";
}

const FIGMA_PATH_RE = regex("/(file|design)/([^/]+)");
const DOC_PATH_RE = regex("/document/d/([^/]+)");
const SHEET_PATH_RE = regex("/spreadsheets/d/([^/]+)");
const SLIDES_PATH_RE = regex("/presentation/d/([^/]+)");
const WIKI_URL_RE = regex.as("https?://[^\\s]+", "i");

type TrackerSearchPayload = {
	issues: Array<Record<string, unknown>>;
	scores: Array<{ key: string | null; score: number }>;
	comments: Record<string, { text: string; truncated: boolean }>;
	ambiguous: boolean;
	candidates: Array<{ key: string | null; summary: string; score: number }>;
};

function extractFigmaFileKey(input: string): string | null {
	try {
		const url = new URL(input);
		if (!url.hostname.endsWith("figma.com")) return null;
		const match = url.pathname.match(FIGMA_PATH_RE);
		return match?.[2] ?? null;
	} catch {
		return null;
	}
}

function extractFigmaNodeId(input: string): string | null {
	try {
		const url = new URL(input);
		if (!url.hostname.endsWith("figma.com")) return null;
		const nodeId =
			url.searchParams.get("node-id") ?? url.hash.replace("#node-id=", "");
		return nodeId?.trim() || null;
	} catch {
		return null;
	}
}

function parseWikiReference(input: string): { id?: number; slug?: string } {
	const trimmed = input.trim();
	if (!trimmed) return {};
	if (WIKI_NUMERIC_ID_RE.test(trimmed)) {
		return { id: Number(trimmed) };
	}
	if (WIKI_URL_RE.test(trimmed)) {
		try {
			const url = new URL(trimmed);
			const path = url.pathname
				.replace(WIKI_PATH_LEADING_SLASH_RE, "")
				.replace(WIKI_PATH_TRAILING_SLASH_RE, "");
			if (path && WIKI_NUMERIC_ID_RE.test(path)) {
				return { id: Number(path) };
			}
			return path ? { slug: path } : {};
		} catch {
			return {};
		}
	}
	return { slug: trimmed };
}

function buildMemoryTools(config: {
	apiKey: string;
	projectId: string;
	tagPrefix: string;
	chatId?: string;
}) {
	if (!config.apiKey || !config.chatId) return {};
	const containerTags = [`${config.tagPrefix}${config.chatId}`];
	const options = config.projectId
		? { projectId: config.projectId, containerTags }
		: { containerTags };
	return supermemoryTools(config.apiKey, options);
}

export function createAgentToolsFactory(
	deps: AgentToolsDeps,
): AgentToolsFactory {
	return async function createAgentTools(options?: CreateAgentToolsOptions) {
		const registry = createToolRegistry({ logger: deps.toolConflictLogger });
		const toolMap: ToolSet = {};
		const registerTool = (meta: ToolMeta, toolDef: ToolSet[string]) => {
			const res = registry.register(meta);
			if (!res.ok) return;
			toolMap[meta.name] = toolDef;
		};
		const gemini = deps.geminiApiKey
			? createGoogleGenerativeAI({ apiKey: deps.geminiApiKey })
			: null;

		const memoryTools = buildMemoryTools({
			apiKey: deps.supermemoryApiKey,
			projectId: deps.supermemoryProjectId,
			tagPrefix: deps.supermemoryTagPrefix,
			chatId: options?.chatId,
		});
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
			deps.webSearchContextSize.trim().toLowerCase(),
		);
		const allowWebSearch =
			typeof options?.webSearchEnabled === "boolean"
				? options.webSearchEnabled
				: deps.webSearchEnabled;
		if (allowWebSearch) {
			registerTool(
				{
					name: "web_search",
					description:
						"Search the web for up-to-date information (OpenAI web_search).",
					source: "web",
					origin: "openai",
				},
				openai.tools.webSearch({
					searchContextSize: webSearchContextSize,
				}) as unknown as ToolSet[string],
			);
		}

		if (gemini) {
			registerTool(
				{
					name: "gemini_image_generate",
					description:
						"Generate an image with Gemini 3 Pro Image Preview (Google).",
					source: "core",
					origin: "gemini",
				},
				tool({
					description:
						"Generate an image with Gemini 3 Pro Image Preview (Google).",
					inputSchema: z.object({
						prompt: z.string().describe("Image description prompt"),
						aspectRatio: z
							.enum(GEMINI_IMAGE_ASPECT_RATIOS)
							.optional()
							.describe("Optional aspect ratio (e.g. 1:1, 16:9)"),
					}),
					execute: async ({ prompt, aspectRatio }) => {
						const startedAt = Date.now();
						try {
							const result = await generateText({
								model: gemini(
									GEMINI_IMAGE_MODEL_ID,
								) as unknown as LanguageModel,
								prompt,
								providerOptions: {
									google: {
										responseModalities: ["TEXT", "IMAGE"],
										imageConfig: {
											aspectRatio,
											imageSize: deps.geminiImageSize ?? "1K",
										},
									},
								},
							});
							const images: FilePart[] = [];
							const imageFiles = (result.files ?? []).filter((file) =>
								file.mediaType?.startsWith("image/"),
							);
							for (const [index, file] of imageFiles.entries()) {
								if (images.length >= 1) break;
								const mediaType = file.mediaType ?? "image/png";
								const filename = `gemini-image-${index + 1}.${resolveImageExtension(mediaType)}`;
								const buffer =
									file.uint8Array ??
									(file.base64 ? decodeBase64Payload(file.base64) : null);
								if (deps.imageStore && buffer) {
									const stored = await deps.imageStore.putImage({
										buffer,
										mediaType,
										filename,
										chatId: options?.chatId,
										userId: options?.ctx?.from?.id?.toString(),
									});
									images.push({
										mediaType: stored.mediaType,
										url: stored.url,
										filename: stored.filename ?? filename,
									});
									const ctxAny = options?.ctx as
										| (BotContext & {
												replyWithPhoto?: (
													photo: string,
													options?: Record<string, unknown>,
												) => Promise<unknown>;
										  })
										| undefined;
									if (ctxAny?.replyWithPhoto) {
										try {
											await ctxAny.replyWithPhoto(stored.url);
										} catch (error) {
											deps.logDebug(
												"gemini_image_generate telegram send error",
												{
													error: String(error),
												},
											);
										}
									}
									continue;
								}
								if (buffer) {
									images.push(
										toFilePart({
											buffer,
											mediaType,
											filename,
										}),
									);
									continue;
								}
								if (file.base64) {
									const url = file.base64.startsWith("data:")
										? file.base64
										: `data:${mediaType};base64,${file.base64}`;
									images.push({ mediaType, url, filename });
								}
							}

							deps.logDebug("gemini_image_generate result", {
								durationMs: Date.now() - startedAt,
								imageCount: images.length,
								hasText: Boolean(result.text?.trim()),
							});
							return {
								ok: images.length > 0,
								text: result.text ?? "",
								images,
							};
						} catch (error) {
							deps.logDebug("gemini_image_generate error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);
		}

		const runTrackerSearch = async (
			question: string,
			queue?: string,
		): Promise<TrackerSearchPayload | { error: string }> => {
			const startedAt = Date.now();
			const commentStats = { fetched: 0, cacheHits: 0 };
			const queueKey = queue ?? deps.defaultTrackerQueue;
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
			deps.logDebug("yandex_tracker_search", payload);
			try {
				const result = await deps.trackerClient.trackerCallTool(
					"issues_find",
					payload,
					8_000,
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
				const commentDeadline = startedAt + deps.commentsFetchBudgetMs;
				await deps.trackerClient.fetchCommentsWithBudget(
					top.map((entry) => entry.key ?? ""),
					commentsByIssue,
					commentDeadline,
					commentStats,
					options?.ctx,
				);

				let selected = top;
				if (haveKeywords) {
					const matches = top.filter((entry) => {
						const summary = getIssueField(entry.issue, ["summary", "title"]);
						const description = getIssueField(entry.issue, ["description"]);
						const comments = entry.key
							? (commentsByIssue[entry.key]?.text ?? "")
							: "";
						const haystack = `${summary} ${description} ${comments}`;
						return matchesKeywords(haystack, keywords);
					});
					if (matches.length) {
						selected = matches;
						deps.logDebug("yandex_tracker_search filtered", {
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
					selected.length > 1 && (topScore <= 3 || topScore - secondScore < 3);

				if (options?.onCandidates) {
					options.onCandidates(topCandidates);
				}

				deps.logDebug("yandex_tracker_search result", {
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
				deps.logDebug("yandex_tracker_search error", { error: String(error) });
				return { error: String(error) };
			}
		};

		registerTool(
			{
				name: "yandex_tracker_search",
				description: `Search Yandex Tracker issues in queue ${deps.defaultTrackerQueue} using keywords from the question.`,
				source: "tracker",
				origin: "core",
			},
			tool({
				description: `Search Yandex Tracker issues in queue ${deps.defaultTrackerQueue} using keywords from the question.`,
				inputSchema: z.object({
					question: z.string().describe("User question or keywords"),
					queue: z
						.string()
						.optional()
						.describe(`Queue key, defaults to ${deps.defaultTrackerQueue}`),
				}),
				execute: async ({ question, queue }) =>
					runTrackerSearch(question, queue),
			}),
		);

		registerTool(
			{
				name: "yandex_tracker_find_issue",
				description:
					"Find the best matching Yandex Tracker issues for a question.",
				source: "tracker",
				origin: "core",
			},
			tool({
				description:
					"Find the best matching Yandex Tracker issues for a question.",
				inputSchema: z.object({
					question: z.string().describe("User question or keywords"),
					queue: z
						.string()
						.optional()
						.describe(`Queue key, defaults to ${deps.defaultTrackerQueue}`),
				}),
				execute: async ({ question, queue }) => {
					const result = await runTrackerSearch(question, queue);
					if ("error" in result) return result;
					return {
						candidates: result.candidates,
						ambiguous: result.ambiguous,
					};
				},
			}),
		);

		registerTool(
			{
				name: "yandex_tracker_issue_summary",
				description:
					"Summarize a Yandex Tracker issue with key fields and last comments.",
				source: "tracker",
				origin: "core",
			},
			tool({
				description:
					"Summarize a Yandex Tracker issue with key fields and last comments.",
				inputSchema: z.object({
					issueKey: z.string().describe("Issue key (e.g., PROJ-123)"),
				}),
				execute: async ({ issueKey }) => {
					const startedAt = Date.now();
					try {
						const [issueResult, commentResult, attachmentsResult] =
							await Promise.all([
								deps.trackerClient.trackerCallTool(
									"issue_get",
									{ issue_id: issueKey },
									8_000,
									options?.ctx,
								),
								deps.trackerClient.trackerCallTool(
									"issue_get_comments",
									{ issue_id: issueKey },
									8_000,
									options?.ctx,
								),
								deps.trackerClient
									.trackerCallTool(
										"issue_get_attachments",
										{ issue_id: issueKey },
										8_000,
										options?.ctx,
									)
									.catch(() => []),
							]);
						const issue = issueResult as Record<string, unknown>;
						const summary = getIssueField(issue, ["summary", "title"]);
						const status =
							(issue.status as { display?: string; name?: string })?.display ??
							(issue.status as { name?: string })?.name ??
							"";
						const updatedAt =
							typeof issue.updated_at === "string"
								? issue.updated_at
								: typeof issue.updatedAt === "string"
									? issue.updatedAt
									: "";
						const assignee =
							(issue.assignee as { display?: string; name?: string })
								?.display ??
							(issue.assignee as { name?: string })?.name ??
							"";
						const priority =
							(issue.priority as { display?: string; name?: string })
								?.display ??
							(issue.priority as { name?: string })?.name ??
							"";
						const commentsText = Array.isArray(commentResult)
							? commentResult
									.map((item) => (item as { text?: string }).text ?? "")
									.filter(Boolean)
									.join("\n")
							: "";
						const lastComment = commentsText
							? (commentsText.split("\n").pop() ?? "")
							: "";
						const hasAttachments = Array.isArray(attachmentsResult)
							? attachmentsResult.length > 0
							: false;
						const summaryLine = [
							issueKey,
							summary,
							status ? `— ${status}` : "",
							assignee ? `@${assignee}` : "",
							priority ? `(${priority})` : "",
						]
							.filter(Boolean)
							.join(" ");
						return {
							ok: true,
							key: issueKey,
							summary: summaryLine,
							status,
							updatedAt,
							assignee,
							priority,
							lastComment: lastComment ? lastComment.slice(0, 400) : "",
							hasAttachments,
							elapsedMs: Date.now() - startedAt,
						};
					} catch (error) {
						deps.logDebug("yandex_tracker_issue_summary error", {
							error: String(error),
						});
						return { error: String(error) };
					}
				},
			}),
		);

		registerTool(
			{
				name: "google_public_doc_read",
				description: "Read a public Google Doc by shared link.",
				source: "web",
				origin: "google-public",
			},
			tool({
				description: "Read a public Google Doc by shared link.",
				inputSchema: z.object({
					url: z.string().describe("Google Docs shared URL"),
				}),
				execute: async ({ url }) => {
					try {
						const parsed = new URL(url);
						if (!parsed.hostname.endsWith("docs.google.com")) {
							throw new Error("unsupported_host");
						}
						const match = parsed.pathname.match(DOC_PATH_RE);
						const docId = match?.[1];
						if (!docId) throw new Error("missing_doc_id");
						const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
						const response = await fetch(exportUrl);
						if (!response.ok) {
							const body = await response.text();
							throw new Error(
								`doc_fetch_error:${response.status}:${response.statusText}:${body}`,
							);
						}
						const text = await response.text();
						return {
							ok: true,
							docId,
							chars: text.length,
							text,
						};
					} catch (error) {
						deps.logDebug("google_public_doc_read error", {
							error: String(error),
						});
						return { error: String(error) };
					}
				},
			}),
		);

		registerTool(
			{
				name: "google_public_sheet_read",
				description: "Read a public Google Sheet by shared link.",
				source: "web",
				origin: "google-public",
			},
			tool({
				description: "Read a public Google Sheet by shared link.",
				inputSchema: z.object({
					url: z.string().describe("Google Sheets shared URL"),
					gid: z.string().optional().describe("Sheet gid (overrides link gid)"),
					format: z.enum(["csv", "tsv"]).optional().describe("Export format"),
				}),
				execute: async ({ url, gid, format }) => {
					try {
						const parsed = new URL(url);
						if (!parsed.hostname.endsWith("docs.google.com")) {
							throw new Error("unsupported_host");
						}
						const match = parsed.pathname.match(SHEET_PATH_RE);
						const sheetId = match?.[1];
						if (!sheetId) throw new Error("missing_sheet_id");
						const resolvedGid =
							gid ??
							parsed.searchParams.get("gid") ??
							parsed.hash.replace("#gid=", "").trim() ??
							"0";
						const exportFormat = format ?? "csv";
						const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=${exportFormat}&gid=${resolvedGid}`;
						const response = await fetch(exportUrl);
						if (!response.ok) {
							const body = await response.text();
							throw new Error(
								`sheet_fetch_error:${response.status}:${response.statusText}:${body}`,
							);
						}
						const text = await response.text();
						return {
							ok: true,
							sheetId,
							gid: resolvedGid,
							format: exportFormat,
							chars: text.length,
							text,
						};
					} catch (error) {
						deps.logDebug("google_public_sheet_read error", {
							error: String(error),
						});
						return { error: String(error) };
					}
				},
			}),
		);

		registerTool(
			{
				name: "google_public_slides_read",
				description: "Read a public Google Slides deck by shared link.",
				source: "web",
				origin: "google-public",
			},
			tool({
				description: "Read a public Google Slides deck by shared link.",
				inputSchema: z.object({
					url: z.string().describe("Google Slides shared URL"),
				}),
				execute: async ({ url }) => {
					try {
						const parsed = new URL(url);
						if (!parsed.hostname.endsWith("docs.google.com")) {
							throw new Error("unsupported_host");
						}
						const match = parsed.pathname.match(SLIDES_PATH_RE);
						const deckId = match?.[1];
						if (!deckId) throw new Error("missing_slides_id");
						const exportUrl = `https://docs.google.com/presentation/d/${deckId}/export?format=txt`;
						const response = await fetch(exportUrl);
						if (!response.ok) {
							const body = await response.text();
							throw new Error(
								`slides_fetch_error:${response.status}:${response.statusText}:${body}`,
							);
						}
						const text = await response.text();
						return {
							ok: true,
							deckId,
							chars: text.length,
							text,
						};
					} catch (error) {
						deps.logDebug("google_public_slides_read error", {
							error: String(error),
						});
						return { error: String(error) };
					}
				},
			}),
		);

		if (deps.figmaEnabled) {
			registerTool(
				{
					name: "figma_me",
					description: "Get current Figma user profile.",
					source: "figma",
					origin: "figma",
				},
				tool({
					description: "Get current Figma user profile.",
					inputSchema: z.object({}),
					execute: async () => {
						try {
							return await deps.figmaClient.figmaMe();
						} catch (error) {
							deps.logDebug("figma_me error", { error: String(error) });
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "figma_file_get",
					description: "Get Figma file metadata and document tree.",
					source: "figma",
					origin: "figma",
				},
				tool({
					description: "Get Figma file metadata and document tree.",
					inputSchema: z.object({
						fileKey: z.string().optional().describe("Figma file key"),
						url: z.string().optional().describe("Figma file URL"),
						version: z.string().optional().describe("File version id"),
						ids: z.array(z.string()).optional().describe("Node ids to include"),
						depth: z.number().int().optional().describe("Depth of the tree"),
						geometry: z
							.enum(["paths", "bounds"])
							.optional()
							.describe("Geometry format"),
						pluginData: z
							.string()
							.optional()
							.describe("Plugin id to include data for"),
						branchData: z.boolean().optional().describe("Include branch data"),
					}),
					execute: async ({
						fileKey,
						url,
						version,
						ids,
						depth,
						geometry,
						pluginData,
						branchData,
					}) => {
						try {
							const resolvedKey =
								fileKey ?? (url ? extractFigmaFileKey(url) : null);
							if (!resolvedKey) {
								throw new Error("missing_file_key");
							}
							const safeDepth =
								typeof depth === "number" ? Math.min(depth, 2) : depth;
							return await deps.figmaClient.figmaFileGet({
								fileKey: resolvedKey,
								version,
								ids,
								depth: safeDepth,
								geometry,
								pluginData,
								branchData,
							});
						} catch (error) {
							deps.logDebug("figma_file_get error", { error: String(error) });
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "figma_file_nodes_get",
					description: "Get specific nodes from a Figma file.",
					source: "figma",
					origin: "figma",
				},
				tool({
					description: "Get specific nodes from a Figma file.",
					inputSchema: z.object({
						fileKey: z.string().optional().describe("Figma file key"),
						url: z.string().optional().describe("Figma file URL"),
						ids: z.array(z.string()).optional().describe("Node ids to fetch"),
						nodeId: z
							.string()
							.optional()
							.describe("Single node id (alternative to ids)"),
						version: z.string().optional().describe("File version id"),
						depth: z.number().int().optional().describe("Depth of the tree"),
						geometry: z
							.enum(["paths", "bounds"])
							.optional()
							.describe("Geometry format"),
						pluginData: z
							.string()
							.optional()
							.describe("Plugin id to include data for"),
						branchData: z.boolean().optional().describe("Include branch data"),
					}),
					execute: async ({
						fileKey,
						url,
						ids,
						nodeId,
						version,
						depth,
						geometry,
						pluginData,
						branchData,
					}) => {
						const resolvedKey =
							fileKey ?? (url ? extractFigmaFileKey(url) : null);
						if (!resolvedKey) {
							return { error: "missing_file_key" };
						}
						const safeDepth =
							typeof depth === "number" ? Math.min(depth, 2) : depth;
						const resolvedIds =
							ids?.length && ids.length > 0
								? ids
								: nodeId
									? [nodeId]
									: url
										? (() => {
												const fromUrl = extractFigmaNodeId(url);
												return fromUrl ? [fromUrl] : [];
											})()
										: [];
						if (!resolvedIds.length) {
							return { error: "missing_node_ids" };
						}
						try {
							return await deps.figmaClient.figmaFileNodesGet({
								fileKey: resolvedKey,
								ids: resolvedIds,
								version,
								depth: safeDepth,
								geometry,
								pluginData,
								branchData,
							});
						} catch (error) {
							const message = String(error);
							if (
								message.includes("AbortError") ||
								message.includes("timeout")
							) {
								try {
									await deps.figmaClient.figmaFileGet({
										fileKey: resolvedKey,
										version,
										ids: resolvedIds,
										depth: 1,
										geometry,
										pluginData,
										branchData,
									});
									return await deps.figmaClient.figmaFileNodesGet({
										fileKey: resolvedKey,
										ids: resolvedIds,
										version,
										depth: 1,
										geometry,
										pluginData,
										branchData,
									});
								} catch (fallbackError) {
									deps.logDebug("figma_file_nodes_get fallback error", {
										error: String(fallbackError),
									});
								}
							}
							deps.logDebug("figma_file_nodes_get error", {
								error: message,
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "figma_file_comments_list",
					description: "List comments for a Figma file.",
					source: "figma",
					origin: "figma",
				},
				tool({
					description: "List comments for a Figma file.",
					inputSchema: z.object({
						fileKey: z.string().optional().describe("Figma file key"),
						url: z.string().optional().describe("Figma file URL"),
						limit: z
							.number()
							.int()
							.optional()
							.describe("Max comments to return"),
						after: z.string().optional().describe("Pagination cursor"),
					}),
					execute: async ({ fileKey, url, limit, after }) => {
						try {
							const resolvedKey =
								fileKey ?? (url ? extractFigmaFileKey(url) : null);
							if (!resolvedKey) {
								throw new Error("missing_file_key");
							}
							return await deps.figmaClient.figmaFileCommentsList({
								fileKey: resolvedKey,
								limit,
								after,
							});
						} catch (error) {
							deps.logDebug("figma_file_comments_list error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "figma_project_files_list",
					description: "List files in a Figma project.",
					source: "figma",
					origin: "figma",
				},
				tool({
					description: "List files in a Figma project.",
					inputSchema: z.object({
						projectId: z.string().describe("Figma project id"),
					}),
					execute: async ({ projectId }) => {
						try {
							return await deps.figmaClient.figmaProjectFilesList({
								projectId,
							});
						} catch (error) {
							deps.logDebug("figma_project_files_list error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);
		}

		if (deps.wikiEnabled) {
			registerTool(
				{
					name: "yandex_wiki_find_page",
					description: "Resolve a Yandex Wiki page by URL, slug, or id.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Resolve a Yandex Wiki page by URL, slug, or id.",
					inputSchema: z.object({
						query: z.string().describe("Wiki page URL, slug, or numeric id"),
						fields: z
							.string()
							.optional()
							.describe("Comma-separated fields for the wiki API"),
						raiseOnRedirect: z
							.boolean()
							.optional()
							.describe("Throw if the page is a redirect"),
						followRedirects: z
							.boolean()
							.optional()
							.describe("Follow redirects automatically"),
					}),
					execute: async ({
						query,
						fields,
						raiseOnRedirect,
						followRedirects,
					}) => {
						const ref = parseWikiReference(query);
						if (ref.id) {
							try {
								const page = await deps.wikiClient.wikiPageGetById({
									id: ref.id,
									fields,
									raiseOnRedirect,
									followRedirects,
								});
								return { ok: true, page };
							} catch (error) {
								deps.logDebug("yandex_wiki_find_page error", {
									error: String(error),
								});
								return { error: String(error) };
							}
						}
						if (ref.slug) {
							try {
								const page = await deps.wikiClient.wikiPageGet({
									slug: ref.slug,
									fields,
									raiseOnRedirect,
								});
								return { ok: true, page };
							} catch (error) {
								deps.logDebug("yandex_wiki_find_page error", {
									error: String(error),
								});
								return { error: String(error) };
							}
						}
						return { error: "wiki_reference_not_found" };
					},
				}),
			);

			registerTool(
				{
					name: "yandex_wiki_read_page",
					description: "Read a Yandex Wiki page by URL, slug, or id.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Read a Yandex Wiki page by URL, slug, or id.",
					inputSchema: z.object({
						ref: z.string().describe("Wiki page URL, slug, or numeric id"),
						fields: z
							.string()
							.optional()
							.describe("Comma-separated fields for the wiki API"),
						raiseOnRedirect: z
							.boolean()
							.optional()
							.describe("Throw if the page is a redirect"),
						followRedirects: z
							.boolean()
							.optional()
							.describe("Follow redirects automatically"),
					}),
					execute: async ({
						ref,
						fields,
						raiseOnRedirect,
						followRedirects,
					}) => {
						const resolved = parseWikiReference(ref);
						try {
							if (resolved.id) {
								return await deps.wikiClient.wikiPageGetById({
									id: resolved.id,
									fields,
									raiseOnRedirect,
									followRedirects,
								});
							}
							if (resolved.slug) {
								return await deps.wikiClient.wikiPageGet({
									slug: resolved.slug,
									fields,
									raiseOnRedirect,
								});
							}
							return { error: "wiki_reference_not_found" };
						} catch (error) {
							deps.logDebug("yandex_wiki_read_page error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "yandex_wiki_update_page",
					description: "Update a Yandex Wiki page by id.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Update a Yandex Wiki page by id.",
					inputSchema: z.object({
						id: z.number().describe("Page id"),
						title: z.string().optional().describe("New title"),
						content: z.string().optional().describe("New content"),
						allowMerge: z.boolean().optional().describe("Allow merging edits"),
						isSilent: z.boolean().optional().describe("Suppress notifications"),
					}),
					execute: async ({ id, title, content, allowMerge, isSilent }) => {
						try {
							return await deps.wikiClient.wikiPageUpdate({
								id,
								title,
								content,
								allowMerge,
								isSilent,
							});
						} catch (error) {
							deps.logDebug("yandex_wiki_update_page error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "yandex_wiki_append_page",
					description: "Append content to a Yandex Wiki page by id.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Append content to a Yandex Wiki page by id.",
					inputSchema: z.object({
						id: z.number().describe("Page id"),
						content: z.string().describe("Content to append"),
						isSilent: z.boolean().optional().describe("Suppress notifications"),
					}),
					execute: async ({ id, content, isSilent }) => {
						try {
							return await deps.wikiClient.wikiPageAppendContent({
								id,
								content,
								isSilent,
							});
						} catch (error) {
							deps.logDebug("yandex_wiki_append_page error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "wiki_page_get",
					description: "Get Yandex Wiki page details by slug.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Get Yandex Wiki page details by slug.",
					inputSchema: z.object({
						slug: z.string().describe("Page slug"),
						fields: z
							.string()
							.optional()
							.describe(
								"Comma-separated fields: content,attributes,urls,breadcrumbs,redirect",
							),
						raiseOnRedirect: z
							.boolean()
							.optional()
							.describe("Throw if the page is a redirect"),
						revisionId: z.number().optional().describe("Specific revision id"),
					}),
					execute: async ({ slug, fields, raiseOnRedirect, revisionId }) => {
						try {
							return await deps.wikiClient.wikiPageGet({
								slug,
								fields,
								raiseOnRedirect,
								revisionId,
							});
						} catch (error) {
							deps.logDebug("wiki_page_get error", { error: String(error) });
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "wiki_page_get_by_id",
					description: "Get Yandex Wiki page details by id.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Get Yandex Wiki page details by id.",
					inputSchema: z.object({
						id: z.number().describe("Page id"),
						fields: z
							.string()
							.optional()
							.describe(
								"Comma-separated fields: content,attributes,urls,breadcrumbs,redirect",
							),
						raiseOnRedirect: z
							.boolean()
							.optional()
							.describe("Throw if the page is a redirect"),
						followRedirects: z
							.boolean()
							.optional()
							.describe("Follow redirects automatically"),
						revisionId: z.number().optional().describe("Specific revision id"),
					}),
					execute: async ({
						id,
						fields,
						raiseOnRedirect,
						followRedirects,
						revisionId,
					}) => {
						try {
							return await deps.wikiClient.wikiPageGetById({
								id,
								fields,
								raiseOnRedirect,
								followRedirects,
								revisionId,
							});
						} catch (error) {
							deps.logDebug("wiki_page_get_by_id error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "wiki_page_create",
					description: "Create a new Yandex Wiki page.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Create a new Yandex Wiki page.",
					inputSchema: z.object({
						slug: z.string().describe("Page slug"),
						title: z.string().describe("Page title"),
						content: z.string().optional().describe("Page content"),
						pageType: z
							.string()
							.optional()
							.describe("page, grid, cloud_page, wysiwyg, template"),
						gridFormat: z.string().optional().describe("Grid format"),
						cloudPage: z
							.record(z.any())
							.optional()
							.describe("Cloud page payload"),
						fields: z
							.string()
							.optional()
							.describe(
								"Comma-separated fields: content,attributes,urls,breadcrumbs,redirect",
							),
						isSilent: z.boolean().optional().describe("Suppress notifications"),
					}),
					execute: async ({
						slug,
						title,
						content,
						pageType,
						gridFormat,
						cloudPage,
						fields,
						isSilent,
					}) => {
						try {
							return await deps.wikiClient.wikiPageCreate({
								pageType: pageType ?? "wysiwyg",
								slug,
								title,
								content,
								gridFormat,
								cloudPage,
								fields,
								isSilent,
							});
						} catch (error) {
							deps.logDebug("wiki_page_create error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "wiki_page_update",
					description: "Update an existing Yandex Wiki page.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Update an existing Yandex Wiki page.",
					inputSchema: z.object({
						id: z.number().describe("Page id"),
						title: z.string().optional().describe("New title"),
						content: z.string().optional().describe("New content"),
						redirect: z.record(z.any()).optional().describe("Redirect payload"),
						allowMerge: z.boolean().optional().describe("Allow merging edits"),
						fields: z
							.string()
							.optional()
							.describe(
								"Comma-separated fields: content,attributes,urls,breadcrumbs,redirect",
							),
						isSilent: z.boolean().optional().describe("Suppress notifications"),
					}),
					execute: async ({
						id,
						title,
						content,
						redirect,
						allowMerge,
						fields,
						isSilent,
					}) => {
						try {
							return await deps.wikiClient.wikiPageUpdate({
								id,
								title,
								content,
								redirect,
								allowMerge,
								fields,
								isSilent,
							});
						} catch (error) {
							deps.logDebug("wiki_page_update error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);

			registerTool(
				{
					name: "wiki_page_append_content",
					description: "Append content to an existing Yandex Wiki page.",
					source: "wiki",
					origin: "yandex-wiki",
				},
				tool({
					description: "Append content to an existing Yandex Wiki page.",
					inputSchema: z.object({
						id: z.number().describe("Page id"),
						content: z.string().describe("Content to append"),
						body: z
							.record(z.any())
							.optional()
							.describe("Body location payload"),
						anchor: z
							.record(z.any())
							.optional()
							.describe("Anchor placement payload"),
						section: z
							.record(z.any())
							.optional()
							.describe("Section placement payload"),
						fields: z
							.string()
							.optional()
							.describe(
								"Comma-separated fields: content,attributes,urls,breadcrumbs,redirect",
							),
						isSilent: z.boolean().optional().describe("Suppress notifications"),
					}),
					execute: async ({
						id,
						content,
						body,
						anchor,
						section,
						fields,
						isSilent,
					}) => {
						try {
							return await deps.wikiClient.wikiPageAppendContent({
								id,
								content,
								body,
								anchor,
								section,
								fields,
								isSilent,
							});
						} catch (error) {
							deps.logDebug("wiki_page_append_content error", {
								error: String(error),
							});
							return { error: String(error) };
						}
					},
				}),
			);
		}

		if (deps.cronClient) {
			registerTool(
				{
					name: "cron_schedule",
					description:
						"Schedule a recurring report or reminder and deliver it to the current chat (default timezone: Europe/Moscow unless user specifies).",
					source: "cron",
					origin: "core",
				},
				tool({
					description:
						"Create a recurring cron job that runs a prompt and sends the result to Telegram. If the user mentions a different location or timezone, ask to confirm the timezone before scheduling.",
					inputSchema: z.object({
						goal: z.string().describe("What should the report/reminder do?"),
						prompt: z
							.string()
							.optional()
							.describe("Optional custom prompt for the agent."),
						schedule: z.object({
							cadence: z
								.enum(["daily", "weekdays", "weekly", "every"])
								.optional(),
							time: z.string().optional().describe("Time in HH:MM (24h)."),
							timezone: z.string().optional().describe("IANA timezone."),
							dayOfWeek: z
								.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
								.optional()
								.describe("Required for weekly cadence."),
							everyMinutes: z
								.number()
								.int()
								.positive()
								.optional()
								.describe("Required for every cadence."),
						}),
						deliverToChatId: z
							.string()
							.optional()
							.describe("Telegram chat id to deliver to."),
					}),
					execute: async (input) => {
						const chatId =
							input.deliverToChatId ?? options?.ctx?.chat?.id?.toString() ?? "";
						if (!chatId) {
							return {
								ok: false,
								message: "Missing chat id. Ask the user where to deliver.",
							};
						}
						const cadence = input.schedule.cadence ?? "daily";
						const resolvedTimezone = await deps.resolveChatTimezone?.(
							options?.ctx,
							options?.chatId,
						);
						const timezone =
							input.schedule.timezone?.trim() ||
							resolvedTimezone?.trim() ||
							deps.cronStatusTimezone;
						let schedule: Record<string, unknown> | null = null;
						if (cadence === "every") {
							const everyMinutes = input.schedule.everyMinutes;
							if (!everyMinutes) {
								return {
									ok: false,
									message:
										"Need interval minutes for every cadence (e.g. every 60 minutes).",
								};
							}
							schedule = {
								kind: "every",
								everyMs: Math.max(1, everyMinutes) * 60_000,
							};
						} else {
							const time = input.schedule.time
								? parseTime(input.schedule.time)
								: null;
							if (!time) {
								return {
									ok: false,
									message: "Need time in HH:MM (e.g. 11:00).",
								};
							}
							let expr = "";
							if (cadence === "weekdays") {
								expr = buildCronExpr(time, true);
							} else if (cadence === "weekly") {
								const day = input.schedule.dayOfWeek;
								if (!day) {
									return {
										ok: false,
										message: "Need dayOfWeek for weekly cadence (mon/tue/...).",
									};
								}
								const dayMap: Record<string, string> = {
									mon: "1",
									tue: "2",
									wed: "3",
									thu: "4",
									fri: "5",
									sat: "6",
									sun: "0",
								};
								expr = `${time.minute} ${time.hour} * * ${dayMap[day] ?? "*"}`;
							} else {
								expr = buildCronExpr(time, false);
							}
							schedule = { kind: "cron", expr, tz: timezone };
						}

						const goal = input.goal.trim();
						const prompt =
							input.prompt?.trim() ||
							`Prepare a concise report: ${goal}. Include key numbers and a short insight.`;
						const job = {
							name: goal.slice(0, 80),
							description: goal,
							enabled: true,
							schedule,
							sessionTarget: "main",
							wakeMode: "next-heartbeat",
							payload: {
								kind: "agentTurn",
								message: prompt,
								deliver: true,
								channel: "telegram",
								to: chatId,
							},
						};
						const created = await deps.cronClient?.add(job);
						return {
							ok: true,
							message: created
								? `Scheduled: ${formatCronJob(created)}`
								: "Scheduled",
							job: created,
						};
					},
				}),
			);

			registerTool(
				{
					name: "cron_schedule_tracker_mentions",
					description:
						"Schedule tracker mention notifications for a user and deliver them to the current chat.",
					source: "cron",
					origin: "core",
				},
				tool({
					description:
						"Create a recurring cron job that checks tracker mentions for a user and sends a concise notification to Telegram.",
					inputSchema: z.object({
						user: z.string().describe("User name or mention to watch for."),
						schedule: z.object({
							cadence: z
								.enum(["daily", "weekdays", "weekly", "every"])
								.optional(),
							time: z.string().optional().describe("Time in HH:MM (24h)."),
							timezone: z.string().optional().describe("IANA timezone."),
							dayOfWeek: z
								.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
								.optional()
								.describe("Required for weekly cadence."),
							everyMinutes: z
								.number()
								.int()
								.positive()
								.optional()
								.describe("Required for every cadence."),
						}),
						deliverToChatId: z
							.string()
							.optional()
							.describe("Telegram chat id to deliver to."),
					}),
					execute: async (input) => {
						const chatId =
							input.deliverToChatId ?? options?.ctx?.chat?.id?.toString() ?? "";
						if (!chatId) {
							return {
								ok: false,
								message: "Missing chat id. Ask the user where to deliver.",
							};
						}
						const cadence = input.schedule.cadence ?? "daily";
						const resolvedTimezone = await deps.resolveChatTimezone?.(
							options?.ctx,
							options?.chatId,
						);
						const timezone =
							input.schedule.timezone?.trim() ||
							resolvedTimezone?.trim() ||
							deps.cronStatusTimezone;
						let schedule: Record<string, unknown> | null = null;
						if (cadence === "every") {
							const everyMinutes = input.schedule.everyMinutes;
							if (!everyMinutes) {
								return {
									ok: false,
									message:
										"Need interval minutes for every cadence (e.g. every 60 minutes).",
								};
							}
							schedule = {
								kind: "every",
								everyMs: Math.max(1, everyMinutes) * 60_000,
							};
						} else {
							const time = input.schedule.time
								? parseTime(input.schedule.time)
								: null;
							if (!time) {
								return {
									ok: false,
									message: "Need time in HH:MM (e.g. 11:00).",
								};
							}
							let expr = "";
							if (cadence === "weekdays") {
								expr = buildCronExpr(time, true);
							} else if (cadence === "weekly") {
								const day = input.schedule.dayOfWeek;
								if (!day) {
									return {
										ok: false,
										message: "Need dayOfWeek for weekly cadence (mon/tue/...).",
									};
								}
								const dayMap: Record<string, string> = {
									mon: "1",
									tue: "2",
									wed: "3",
									thu: "4",
									fri: "5",
									sat: "6",
									sun: "0",
								};
								expr = `${time.minute} ${time.hour} * * ${dayMap[day] ?? "*"}`;
							} else {
								expr = buildCronExpr(time, false);
							}
							schedule = { kind: "cron", expr, tz: timezone };
						}

						const goal = `Tracker mentions for ${input.user.trim()}`;
						const prompt = [
							`Check Yandex Tracker for mentions of "${input.user.trim()}" in the last 24 hours.`,
							"Summarize any mentions briefly with issue keys and context.",
							"If no mentions, say that there are none.",
						].join(" ");
						const job = {
							name: goal.slice(0, 80),
							description: goal,
							enabled: true,
							schedule,
							sessionTarget: "main",
							wakeMode: "next-heartbeat",
							payload: {
								kind: "agentTurn",
								message: prompt,
								deliver: true,
								channel: "telegram",
								to: chatId,
							},
						};
						const created = await deps.cronClient?.add(job);
						return {
							ok: true,
							message: created
								? `Scheduled: ${formatCronJob(created)}`
								: "Scheduled",
							job: created,
						};
					},
				}),
			);

			registerTool(
				{
					name: "cron_list",
					description: "List scheduled cron jobs.",
					source: "cron",
					origin: "core",
				},
				tool({
					description: "List scheduled cron jobs.",
					inputSchema: z.object({
						includeDisabled: z.boolean().optional(),
					}),
					execute: async ({ includeDisabled }) => {
						const payload = await deps.cronClient?.list({
							includeDisabled: includeDisabled !== false,
						});
						const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
						return {
							ok: true,
							jobs,
							message:
								jobs.length === 0
									? "No cron jobs."
									: jobs.map((job) => formatCronJob(job)),
						};
					},
				}),
			);

			registerTool(
				{
					name: "cron_remove",
					description: "Remove a scheduled cron job by id or name.",
					source: "cron",
					origin: "core",
				},
				tool({
					description: "Remove a scheduled cron job by id or name.",
					inputSchema: z.object({
						target: z.string().describe("Job id or name."),
					}),
					execute: async ({ target }) => {
						const payload = await deps.cronClient?.list({
							includeDisabled: true,
						});
						const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
						const matches = findCronJob(jobs, target);
						if (matches.length === 0) {
							return { ok: false, message: `No job found for ${target}.` };
						}
						if (matches.length > 1) {
							return {
								ok: false,
								message: "Multiple matches found. Please specify a job id.",
							};
						}
						const jobId = (matches[0] as { id?: string }).id ?? target;
						await deps.cronClient?.remove({ jobId });
						return { ok: true, message: `Removed ${jobId}.` };
					},
				}),
			);

			registerTool(
				{
					name: "cron_update",
					description:
						"Update a scheduled cron job (enable/disable or change schedule).",
					source: "cron",
					origin: "core",
				},
				tool({
					description:
						"Update a scheduled cron job. Provide id/jobId or a target name, and a patch with enabled/name/description/schedule.",
					inputSchema: z.object({
						target: z.string().optional().describe("Job id or name."),
						id: z.string().optional(),
						jobId: z.string().optional(),
						enabled: z.boolean().optional(),
						name: z.string().optional(),
						description: z.string().optional(),
						schedule: z
							.object({
								kind: z.enum(["cron", "every"]).optional(),
								expr: z.string().optional().describe("Cron expression."),
								tz: z.string().optional().describe("IANA timezone."),
								everyMinutes: z
									.number()
									.int()
									.positive()
									.optional()
									.describe("Interval minutes for every cadence."),
							})
							.optional(),
					}),
					execute: async ({
						target,
						id,
						jobId,
						enabled,
						name,
						description,
						schedule,
					}) => {
						let resolvedId = id ?? jobId;
						if (!resolvedId && target) {
							const payload = await deps.cronClient?.list({
								includeDisabled: true,
							});
							const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
							const matches = findCronJob(jobs, target);
							if (matches.length === 0) {
								return { ok: false, message: `No job found for ${target}.` };
							}
							if (matches.length > 1) {
								return {
									ok: false,
									message: "Multiple matches found. Please specify a job id.",
								};
							}
							resolvedId = (matches[0] as { id?: string }).id ?? target;
						}
						if (!resolvedId) {
							return { ok: false, message: "Missing job id." };
						}
						const patch: Record<string, unknown> = {};
						if (enabled !== undefined) patch.enabled = enabled;
						if (name !== undefined) patch.name = name;
						if (description !== undefined) patch.description = description;
						if (schedule) {
							if (schedule.kind === "every" || schedule.everyMinutes) {
								const everyMinutes = schedule.everyMinutes ?? 0;
								if (!everyMinutes) {
									return {
										ok: false,
										message: "Need everyMinutes for every cadence.",
									};
								}
								patch.schedule = {
									kind: "every",
									everyMs: Math.max(1, everyMinutes) * 60_000,
								};
							} else if (schedule.expr) {
								patch.schedule = {
									kind: "cron",
									expr: schedule.expr.trim(),
									tz: schedule.tz?.trim() || undefined,
								};
							}
						}
						if (Object.keys(patch).length === 0) {
							return { ok: false, message: "No updates provided." };
						}
						const updated = await deps.cronClient?.update({
							id: resolvedId,
							patch,
						});
						return {
							ok: true,
							message: updated
								? `Updated: ${formatCronJob(updated)}`
								: "Updated",
							job: updated,
						};
					},
				}),
			);

			registerTool(
				{
					name: "cron_run",
					description: "Run a scheduled cron job immediately.",
					source: "cron",
					origin: "core",
				},
				tool({
					description: "Run a cron job by id or name.",
					inputSchema: z.object({
						target: z.string().optional().describe("Job id or name."),
						id: z.string().optional(),
						jobId: z.string().optional(),
						mode: z.enum(["due", "force"]).optional(),
					}),
					execute: async ({ target, id, jobId, mode }) => {
						let resolvedId = id ?? jobId;
						if (!resolvedId && target) {
							const payload = await deps.cronClient?.list({
								includeDisabled: true,
							});
							const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
							const matches = findCronJob(jobs, target);
							if (matches.length === 0) {
								return { ok: false, message: `No job found for ${target}.` };
							}
							if (matches.length > 1) {
								return {
									ok: false,
									message: "Multiple matches found. Please specify a job id.",
								};
							}
							resolvedId = (matches[0] as { id?: string }).id ?? target;
						}
						if (!resolvedId) {
							return { ok: false, message: "Missing job id." };
						}
						await deps.cronClient?.run({
							jobId: resolvedId,
							mode: mode ?? "force",
						});
						return { ok: true, message: `Triggered ${resolvedId}.` };
					},
				}),
			);

			registerTool(
				{
					name: "cron_runs",
					description: "List recent runs for a cron job.",
					source: "cron",
					origin: "core",
				},
				tool({
					description: "List recent cron job runs by id or name.",
					inputSchema: z.object({
						target: z.string().optional().describe("Job id or name."),
						id: z.string().optional(),
						jobId: z.string().optional(),
						limit: z.number().int().positive().optional(),
					}),
					execute: async ({ target, id, jobId, limit }) => {
						let resolvedId = id ?? jobId;
						if (!resolvedId && target) {
							const payload = await deps.cronClient?.list({
								includeDisabled: true,
							});
							const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
							const matches = findCronJob(jobs, target);
							if (matches.length === 0) {
								return { ok: false, message: `No job found for ${target}.` };
							}
							if (matches.length > 1) {
								return {
									ok: false,
									message: "Multiple matches found. Please specify a job id.",
								};
							}
							resolvedId = (matches[0] as { id?: string }).id ?? target;
						}
						if (!resolvedId) {
							return { ok: false, message: "Missing job id." };
						}
						const payload = await deps.cronClient?.runs({
							id: resolvedId,
							limit: limit ?? 10,
						});
						return { ok: true, runs: payload };
					},
				}),
			);

			registerTool(
				{
					name: "cron_status",
					description: "Get cron scheduler status.",
					source: "cron",
					origin: "core",
				},
				tool({
					description: "Get cron scheduler status.",
					inputSchema: z.object({}),
					execute: async () => {
						const payload = await deps.cronClient?.status();
						return { ok: true, status: payload };
					},
				}),
			);
		}

		if (deps.jiraEnabled) {
			registerTool(
				{
					name: "jira_search",
					description: `Search Jira issues in project ${deps.jiraProjectKey} using keywords from the question.`,
					source: "tracker",
					origin: "jira",
				},
				tool({
					description: `Search Jira issues in project ${deps.jiraProjectKey} using keywords from the question.`,
					inputSchema: z.object({
						question: z.string().describe("User question or keywords"),
						project: z
							.string()
							.optional()
							.describe(`Project key, defaults to ${deps.jiraProjectKey}`),
					}),
					execute: async ({ question, project }) => {
						const startedAt = Date.now();
						const commentStats = { fetched: 0, cacheHits: 0 };
						const projectKey = project ?? deps.jiraProjectKey;
						const jql = buildJiraJql(question, projectKey);
						deps.logDebug("jira_search", { jql, project: projectKey });
						try {
							const issues = await deps.jiraClient.jiraIssuesFind({
								jql,
								maxResults: 50,
								fields: ["summary", "description"],
							});
							const normalized = issues.map((issue) =>
								normalizeJiraIssue(issue),
							);
							const top = normalized.slice(0, 20);
							const commentsByIssue: Record<
								string,
								{ text: string; truncated: boolean }
							> = {};
							const commentDeadline = startedAt + deps.commentsFetchBudgetMs;
							await deps.jiraClient.fetchCommentsWithBudget(
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
							deps.logDebug("jira_search error", { error: String(error) });
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
							(Number.isFinite(deps.jiraBoardId) && deps.jiraBoardId > 0
								? deps.jiraBoardId
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
								const sprint = await deps.jiraClient.jiraSprintFindByName(
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
								issues = await deps.jiraClient.jiraSprintIssues(
									resolvedSprintId as number,
									maxResults,
								);
							} else if (sprintName) {
								const safeName = sprintName.replaceAll('"', "");
								const jql = `project = ${deps.jiraProjectKey} AND sprint = "${safeName}" ORDER BY created DESC`;
								const fallback = await deps.jiraClient.jiraIssuesFind({
									jql,
									maxResults: maxResults ?? 200,
									fields: [
										"summary",
										"status",
										"assignee",
										"duedate",
										"priority",
									],
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
							deps.logJiraAudit(
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
							deps.logJiraAudit(
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
							const issues = await deps.jiraClient.jiraIssuesFind({
								jql,
								maxResults,
								fields: ["summary", "description"],
							});
							deps.logJiraAudit(
								options?.ctx,
								"jira_issues_find",
								{ jql },
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return issues.map((issue) => normalizeJiraIssue(issue));
						} catch (error) {
							deps.logJiraAudit(
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
							const issue = await deps.jiraClient.jiraIssueGet(issueKey);
							deps.logJiraAudit(
								options?.ctx,
								"jira_issue_get",
								{ issueKey },
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return normalizeJiraIssue(issue);
						} catch (error) {
							deps.logJiraAudit(
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
							const comments = await deps.jiraClient.jiraIssueGetComments({
								issueKey,
							});
							deps.logJiraAudit(
								options?.ctx,
								"jira_issue_get_comments",
								{ issueKey },
								"success",
								undefined,
								Date.now() - startedAt,
							);
							return comments;
						} catch (error) {
							deps.logJiraAudit(
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

		if (deps.posthogPersonalApiKey) {
			const posthogTools = await deps.getPosthogTools();
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

		const filtered = filterToolMapByPolicy(toolMap, deps.toolPolicy);
		const chatPolicy = deps.resolveChatToolPolicy(options?.ctx);
		const filteredByChat = filterToolMapByPolicy(filtered.tools, chatPolicy);
		const suppressed = [...filtered.suppressed, ...filteredByChat.suppressed];
		if (deps.debugLogs && suppressed.length > 0) {
			deps.logDebug("tools suppressed by policy", {
				suppressed,
			});
		}
		const chatId = options?.ctx?.chat?.id?.toString();
		const userId = options?.ctx?.from?.id?.toString();
		const wrapped = wrapToolMapWithHooks(filteredByChat.tools as ToolSet, {
			beforeToolCall: ({ toolName, toolCallId, input }) => {
				if (chatPolicy && !isToolAllowed(toolName, chatPolicy)) {
					deps.logger.info({
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
					deps.senderToolAccess,
				);
				if (!senderCheck.allowed) {
					deps.logger.info({
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
					deps.approvalRequired.size > 0 &&
					deps.approvalRequired.has(normalized) &&
					!deps.approvalStore.isApproved(chatId ?? "", normalized)
				) {
					deps.logger.info({
						event: "tool_approval_required",
						tool: toolName,
						tool_call_id: toolCallId,
						chat_id: chatId,
						user_id: userId,
					});
					return { allow: false, reason: "approval_required" };
				}
				const rate = deps.toolRateLimiter.check(toolName, chatId, userId);
				if (!rate.allowed) {
					deps.logger.info({
						event: "tool_rate_limited",
						tool: toolName,
						tool_call_id: toolCallId,
						chat_id: chatId,
						user_id: userId,
						reset_ms: rate.resetMs,
					});
					return { allow: false, reason: "rate_limited" };
				}
				deps.logger.info({
					event: "tool_call",
					tool: toolName,
					tool_call_id: toolCallId,
					chat_id: chatId,
					user_id: userId,
					input,
				});
			},
			onToolStart: ({ toolName }) => {
				options?.onToolStart?.(toolName);
			},
			afterToolCall: ({ toolName, toolCallId, durationMs, error }) => {
				deps.logger.info({
					event: "tool_result",
					tool: toolName,
					tool_call_id: toolCallId,
					chat_id: chatId,
					user_id: userId,
					duration_ms: durationMs,
					error,
				});
			},
		});
		return wrapped;
	};
}

export function createAgentFactory(deps: AgentDeps) {
	return async function createAgent(
		question: string,
		modelRef: string,
		modelConfig: ModelConfig,
		options?: CreateAgentOptions,
	) {
		const channelConfig = options?.ctx?.state.channelConfig;
		const runtimeSkills =
			typeof deps.filterSkillsForChannel === "function"
				? deps.filterSkillsForChannel({
						skills: deps.runtimeSkills ?? [],
						channelConfig,
					})
				: (deps.runtimeSkills ?? []);
		const skillsPrompt = buildSkillsPrompt(runtimeSkills);
		const timeZone =
			typeof deps.resolveChatTimezone === "function"
				? await deps.resolveChatTimezone(options?.ctx, options?.chatId)
				: undefined;
		const currentDateTime = timeZone
			? formatUserDateTime(new Date(), timeZone)
			: "";
		const chatType = options?.ctx?.chat?.type ?? "";
		const runtimeParts = [
			deps.serviceName ? `service=${deps.serviceName}` : "",
			deps.releaseVersion ? `version=${deps.releaseVersion}` : "",
			deps.region ? `region=${deps.region}` : "",
			deps.instanceId ? `instance=${deps.instanceId}` : "",
			modelConfig.label ? `model=${modelConfig.label}` : "",
			modelRef ? `ref=${modelRef}` : "",
			chatType ? `channel=telegram:${chatType}` : "channel=telegram",
		].filter(Boolean);
		const runtimeLine = runtimeParts.length > 0 ? runtimeParts.join(" | ") : "";
		const tools = await deps.getAgentTools();
		const allowWebSearch =
			typeof options?.webSearchEnabled === "boolean"
				? options.webSearchEnabled
				: deps.webSearchEnabled;
		const webSearchMeta = {
			name: "web_search",
			description:
				"Search the web for up-to-date information (OpenAI web_search).",
			source: "web",
			origin: "openai",
		} satisfies ToolMeta;
		const filteredTools = allowWebSearch
			? tools.some((tool) => tool.name === "web_search")
				? tools
				: [...tools, webSearchMeta]
			: tools.filter((tool) => tool.name !== "web_search");
		const toolLines = filteredTools
			.map((toolItem) => {
				const desc = toolItem.description ? ` - ${toolItem.description}` : "";
				return `${toolItem.name}${desc}`;
			})
			.join("\n");
		const instructions = buildAgentInstructions({
			question,
			modelRef,
			modelName: modelConfig.label ?? modelConfig.id,
			reasoning: deps.resolveReasoningFor(modelConfig),
			toolLines,
			recentCandidates: options?.recentCandidates,
			history: options?.history,
			userName: options?.userName,
			globalSoul: deps.soulPrompt,
			channelSoul: options?.ctx?.state.channelConfig?.systemPrompt,
			projectContext: deps.projectContext,
			currentDateTime: currentDateTime
				? `${currentDateTime} (${timeZone ?? "unknown"})`
				: "",
			runtimeLine,
			skillsPrompt,
			promptMode: options?.promptMode,
		});
		const agentTools = await deps.createAgentTools(options);
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
					deps.debugLogs &&
					(repaired.added.length > 0 ||
						repaired.droppedDuplicateCount > 0 ||
						repaired.droppedOrphanCount > 0 ||
						repaired.moved)
				) {
					deps.logDebug("transcript repair", {
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
					options.onToolStep?.(names);
				}
			},
		});
	};
}

export function createAgentStreamWithTools(
	agent: ToolLoopAgent,
	text: string,
	files?: FilePart[],
	onToolStep?: (toolNames: string[]) => Promise<void> | void,
	abortSignal?: AbortSignal,
): ReadableStream<UIMessageChunk> {
	const uiMessages = [buildUserUIMessage(text, files)];
	return createUIMessageStream<UIMessage>({
		execute: async ({ writer }) => {
			const stream = await createAgentUIStream({
				agent,
				uiMessages,
				abortSignal,
				onStepFinish: ({ toolCalls }) => {
					const names = (toolCalls ?? [])
						.map((call) => call?.toolName)
						.filter((name): name is string => Boolean(name));
					if (names.length > 0) {
						writer.write({ type: "data-tools", data: { tools: names } });
						onToolStep?.(names);
					}
				},
			});
			const reader = stream.getReader();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				writer.write(value);
				if (value.type === "tool-output-available") {
					const output = value.output as {
						images?: Array<{ mediaType?: unknown; url?: unknown }>;
					};
					const images = Array.isArray(output?.images) ? output.images : [];
					for (const image of images.slice(0, 1)) {
						if (
							image &&
							typeof image.mediaType === "string" &&
							typeof image.url === "string"
						) {
							writer.write({
								type: "file",
								mediaType: image.mediaType,
								url: image.url,
							});
						}
					}
				}
			}
		},
	});
}

export function buildUserUIMessage(
	text: string,
	files?: FilePart[],
): UIMessage {
	const parts: UIMessage["parts"] = [];
	if (text) {
		parts.push({ type: "text", text });
	}
	for (const file of files ?? []) {
		parts.push({
			type: "file",
			mediaType: file.mediaType,
			filename: file.filename,
			url: file.url,
		});
	}
	if (parts.length === 0) {
		parts.push({ type: "text", text: "" });
	}
	return {
		id: crypto.randomUUID(),
		role: "user",
		parts,
	};
}
