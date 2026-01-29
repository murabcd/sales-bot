import type { BotContext } from "../bot/types.js";
import {
	expandTermVariants,
	extractKeywords,
	normalizeForMatch,
} from "../text/normalize.js";

type Logger = {
	info: (payload: Record<string, unknown>) => void;
	error: (payload: Record<string, unknown>) => void;
};

type GetLogContext = (ctx: BotContext) => Record<string, unknown>;

type SetLogContext = (
	ctx: BotContext,
	payload: Record<string, unknown>,
) => void;

export type TrackerToolResult = unknown;

export type TrackerClientConfig = {
	token: string;
	cloudOrgId?: string;
	orgId?: string;
	apiBaseUrl: string;
	commentsCacheTtlMs: number;
	commentsCacheMax: number;
	commentsFetchConcurrency: number;
	logger: Logger;
	getLogContext: GetLogContext;
	setLogContext: SetLogContext;
	logDebug: (event: string, payload?: Record<string, unknown>) => void;
};

export type TrackerClient = {
	trackerCallTool: <T = TrackerToolResult>(
		toolName: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		ctx?: BotContext,
	) => Promise<T>;
	trackerHealthCheck: () => Promise<Record<string, unknown>>;
	getLastTrackerCallAt: () => number | null;
	downloadAttachment: (
		attachmentId: string,
		timeoutMs: number,
	) => Promise<{
		buffer: Uint8Array;
		contentType?: string;
		filename?: string;
		size?: number;
	}>;
	fetchCommentsWithBudget: (
		keys: string[],
		commentsByIssue: Record<string, { text: string; truncated: boolean }>,
		deadlineMs: number,
		stats: { fetched: number; cacheHits: number },
		ctx?: BotContext,
	) => Promise<void>;
};

export function createTrackerClient(
	config: TrackerClientConfig,
): TrackerClient {
	const commentsCache = new Map<
		string,
		{ at: number; value: { text: string; truncated: boolean } }
	>();
	let lastTrackerCallAt: number | null = null;

	function trackerHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `OAuth ${config.token}`,
		};
		if (config.cloudOrgId) {
			headers["X-Cloud-Org-Id"] = config.cloudOrgId;
		} else if (config.orgId) {
			headers["X-Org-Id"] = config.orgId;
		}
		return headers;
	}

	function buildTrackerUrl(pathname: string, query?: Record<string, string>) {
		const base = new URL(config.apiBaseUrl);
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

	function parseContentDispositionFilename(
		value?: string | null,
	): string | null {
		if (!value) return null;
		const utfMatch = value.match(/filename\\*=UTF-8''([^;]+)/i);
		if (utfMatch?.[1]) {
			try {
				return decodeURIComponent(utfMatch[1]);
			} catch {
				return utfMatch[1];
			}
		}
		const match = value.match(/filename="?([^";]+)"?/i);
		return match?.[1] ?? null;
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
		const timeoutMs = options.timeoutMs ?? 8_000;
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
		query?: string;
		filter?: Record<string, unknown>;
		queue?: string;
		keys?: string[] | string;
		order?: string;
		expand?: string | string[];
		fields?: string | string[];
		perPage?: number;
		page?: number;
		scrollId?: string;
		scrollTTLMillis?: number;
		timeoutMs?: number;
	}) {
		if (!options.query && !options.filter && !options.queue && !options.keys)
			return [];
		const query: Record<string, string> = {};
		if (options.perPage) query.perPage = String(options.perPage);
		if (options.page) query.page = String(options.page);
		if (options.scrollId) query.scrollId = options.scrollId;
		if (options.scrollTTLMillis)
			query.scrollTTLMillis = String(options.scrollTTLMillis);
		if (options.expand) {
			query.expand = Array.isArray(options.expand)
				? options.expand.join(",")
				: options.expand;
		}
		if (options.fields) {
			query.fields = Array.isArray(options.fields)
				? options.fields.join(",")
				: options.fields;
		}
		const body: Record<string, unknown> = {};
		if (options.query) body.query = options.query;
		if (options.filter) body.filter = options.filter;
		if (options.queue) body.queue = options.queue;
		if (options.keys) body.keys = options.keys;
		if (options.order) body.order = options.order;
		return trackerRequest<Array<Record<string, unknown>>>(
			"POST",
			"/v3/issues/_search",
			{
				query,
				body,
				timeoutMs: options.timeoutMs,
			},
		);
	}

	async function trackerIssueGet(
		issueId: string,
		timeoutMs?: number,
		options?: { expand?: string | string[]; fields?: string | string[] },
	) {
		if (!issueId) throw new Error("missing_issue_id");
		const query: Record<string, string> = {};
		if (options?.expand) {
			query.expand = Array.isArray(options.expand)
				? options.expand.join(",")
				: options.expand;
		}
		if (options?.fields) {
			query.fields = Array.isArray(options.fields)
				? options.fields.join(",")
				: options.fields;
		}
		return trackerRequest<Record<string, unknown>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}`,
			{ query, timeoutMs },
		);
	}

	async function trackerIssueGetComments(
		issueId: string,
		timeoutMs?: number,
		options?: { perPage?: number; page?: number },
	) {
		if (!issueId) throw new Error("missing_issue_id");
		const query: Record<string, string> = {};
		if (options?.perPage) query.perPage = String(options.perPage);
		if (options?.page) query.page = String(options.page);
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}/comments`,
			{ query, timeoutMs },
		);
	}

	async function trackerIssueGetLinks(issueId: string, timeoutMs?: number) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}/links`,
			{ timeoutMs },
		);
	}

	async function trackerIssueGetWorklogs(issueId: string, timeoutMs?: number) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}/worklog`,
			{ timeoutMs },
		);
	}

	async function trackerIssueGetChecklist(issueId: string, timeoutMs?: number) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}/checklistItems`,
			{ timeoutMs },
		);
	}

	async function trackerIssueGetTransitions(
		issueId: string,
		timeoutMs?: number,
	) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}/transitions`,
			{ timeoutMs },
		);
	}

	async function trackerIssueExecuteTransition(
		issueId: string,
		transitionId: string,
		body: Record<string, unknown>,
		timeoutMs?: number,
	) {
		if (!issueId) throw new Error("missing_issue_id");
		if (!transitionId) throw new Error("missing_transition_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"POST",
			`/v3/issues/${encodeURIComponent(issueId)}/transitions/${encodeURIComponent(transitionId)}/_execute`,
			{ body, timeoutMs },
		);
	}

	async function trackerIssueGetAttachments(
		issueId: string,
		timeoutMs?: number,
	) {
		if (!issueId) throw new Error("missing_issue_id");
		const issue = await trackerRequest<Record<string, unknown>>(
			"GET",
			`/v3/issues/${encodeURIComponent(issueId)}`,
			{ query: { expand: "attachments" }, timeoutMs },
		);
		const attachments =
			issue && typeof issue === "object" && "attachments" in issue
				? (issue as { attachments?: unknown }).attachments
				: undefined;
		return Array.isArray(attachments) ? attachments : [];
	}

	async function trackerIssueCreate(
		body: Record<string, unknown>,
		timeoutMs?: number,
	) {
		return trackerRequest<Record<string, unknown>>("POST", "/v3/issues/", {
			body,
			timeoutMs,
		});
	}

	async function trackerIssueUpdate(
		issueId: string,
		body: Record<string, unknown>,
		timeoutMs?: number,
	) {
		if (!issueId) throw new Error("missing_issue_id");
		return trackerRequest<Record<string, unknown>>(
			"PATCH",
			`/v3/issues/${encodeURIComponent(issueId)}`,
			{ body, timeoutMs },
		);
	}

	async function trackerIssuesCount(
		body: Record<string, unknown>,
		timeoutMs?: number,
	) {
		return trackerRequest<number>("POST", "/v3/issues/_count", {
			body,
			timeoutMs,
		});
	}

	async function trackerQueuesGetAll(options: {
		expand?: string | string[];
		perPage?: number;
		page?: number;
		timeoutMs?: number;
	}) {
		const query: Record<string, string> = {};
		if (options.perPage) query.perPage = String(options.perPage);
		if (options.page) query.page = String(options.page);
		if (options.expand) {
			query.expand = Array.isArray(options.expand)
				? options.expand.join(",")
				: options.expand;
		}
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			"/v3/queues/",
			{
				query,
				timeoutMs: options.timeoutMs,
			},
		);
	}

	async function trackerQueueGetMetadata(options: {
		queueId: string;
		expand?: string | string[];
		timeoutMs?: number;
	}) {
		if (!options.queueId) throw new Error("missing_queue_id");
		const query: Record<string, string> = {};
		if (options.expand) {
			query.expand = Array.isArray(options.expand)
				? options.expand.join(",")
				: options.expand;
		}
		return trackerRequest<Record<string, unknown>>(
			"GET",
			`/v3/queues/${encodeURIComponent(options.queueId)}`,
			{ query, timeoutMs: options.timeoutMs },
		);
	}

	async function trackerQueueGetTags(queueId: string, timeoutMs?: number) {
		if (!queueId) throw new Error("missing_queue_id");
		return trackerRequest<Array<string>>(
			"GET",
			`/v3/queues/${encodeURIComponent(queueId)}/tags`,
			{ timeoutMs },
		);
	}

	async function trackerQueueGetVersions(queueId: string, timeoutMs?: number) {
		if (!queueId) throw new Error("missing_queue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/queues/${encodeURIComponent(queueId)}/versions`,
			{ timeoutMs },
		);
	}

	async function trackerQueueGetFields(queueId: string, timeoutMs?: number) {
		if (!queueId) throw new Error("missing_queue_id");
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			`/v3/queues/${encodeURIComponent(queueId)}/fields`,
			{ timeoutMs },
		);
	}

	async function trackerUsersGetAll(options: {
		perPage?: number;
		page?: number;
		timeoutMs?: number;
	}) {
		const query: Record<string, string> = {};
		if (options.perPage) query.perPage = String(options.perPage);
		if (options.page) query.page = String(options.page);
		return trackerRequest<Array<Record<string, unknown>>>("GET", "/v3/users", {
			query,
			timeoutMs: options.timeoutMs,
		});
	}

	async function trackerUserGet(
		userId: string,
		timeoutMs?: number,
	): Promise<Record<string, unknown>> {
		if (!userId) throw new Error("missing_user_id");
		return trackerRequest<Record<string, unknown>>(
			"GET",
			`/v3/users/${encodeURIComponent(userId)}`,
			{ timeoutMs },
		);
	}

	async function trackerUserGetCurrent(timeoutMs?: number) {
		return trackerRequest<Record<string, unknown>>("GET", "/v3/myself", {
			timeoutMs,
		});
	}

	async function trackerUsersSearch(options: {
		needle: string;
		perPage?: number;
		page?: number;
		timeoutMs?: number;
	}) {
		const needle = options.needle.trim().toLowerCase();
		if (!needle) return [];
		const perPage = options.perPage ?? 50;
		const startPage = options.page ?? 1;
		const maxPages = options.page ? 1 : 5;
		let page = startPage;
		const matches: Array<Record<string, unknown>> = [];

		for (let i = 0; i < maxPages; i += 1) {
			const users = await trackerUsersGetAll({
				perPage,
				page,
				timeoutMs: options.timeoutMs,
			});
			if (!Array.isArray(users) || users.length === 0) break;
			for (const user of users) {
				const login =
					typeof user.login === "string" ? user.login.toLowerCase() : "";
				const email =
					typeof user.email === "string" ? user.email.toLowerCase() : "";
				const display =
					typeof user.display === "string" ? user.display.toLowerCase() : "";
				const firstName =
					typeof user.firstName === "string"
						? user.firstName.toLowerCase()
						: "";
				const lastName =
					typeof user.lastName === "string" ? user.lastName.toLowerCase() : "";
				if (
					login.includes(needle) ||
					email.includes(needle) ||
					display.includes(needle) ||
					firstName.includes(needle) ||
					lastName.includes(needle)
				) {
					matches.push(user);
				}
			}
			if (users.length < perPage) break;
			page += 1;
		}

		return matches;
	}

	async function trackerGetGlobalFields(timeoutMs?: number) {
		return trackerRequest<Array<Record<string, unknown>>>("GET", "/v3/fields", {
			timeoutMs,
		});
	}

	async function trackerGetStatuses(timeoutMs?: number) {
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			"/v3/statuses",
			{
				timeoutMs,
			},
		);
	}

	async function trackerGetIssueTypes(timeoutMs?: number) {
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			"/v3/issuetypes",
			{ timeoutMs },
		);
	}

	async function trackerGetPriorities(
		localized: boolean | undefined,
		timeoutMs?: number,
	) {
		const query: Record<string, string> = {};
		if (typeof localized === "boolean") {
			query.localized = localized ? "true" : "false";
		}
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			"/v3/priorities",
			{ query, timeoutMs },
		);
	}

	async function trackerGetResolutions(timeoutMs?: number) {
		return trackerRequest<Array<Record<string, unknown>>>(
			"GET",
			"/v3/resolutions",
			{ timeoutMs },
		);
	}

	async function trackerHealthCheck() {
		return trackerRequest<Record<string, unknown>>("GET", "/v3/myself");
	}

	async function trackerDownloadAttachment(
		attachmentId: string,
		timeoutMs: number,
	) {
		if (!attachmentId) throw new Error("missing_attachment_id");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const headers = trackerHeaders();
			const url = buildTrackerUrl(
				`/v2/attachments/${encodeURIComponent(attachmentId)}`,
			);
			const response = await fetch(url, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`tracker_attachment_error:${response.status}:${response.statusText}:${text}`,
				);
			}
			const buffer = new Uint8Array(await response.arrayBuffer());
			const contentType = response.headers.get("content-type") ?? undefined;
			const sizeHeader = response.headers.get("content-length");
			const size = sizeHeader ? Number(sizeHeader) : undefined;
			const filename =
				parseContentDispositionFilename(
					response.headers.get("content-disposition"),
				) ?? `attachment-${attachmentId}`;
			return { buffer, contentType, filename, size };
		} finally {
			clearTimeout(timeout);
		}
	}

	function getCachedComments(
		issueId: string,
	): { text: string; truncated: boolean } | null {
		const cached = commentsCache.get(issueId);
		if (!cached) return null;
		if (Date.now() - cached.at > config.commentsCacheTtlMs) {
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
		if (commentsCache.size <= config.commentsCacheMax) return;
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
		const context = ctx ? config.getLogContext(ctx) : {};
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
		config.logger[level](payload);
	}

	async function trackerCallTool<T = TrackerToolResult>(
		toolName: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		ctx?: BotContext,
	): Promise<T> {
		lastTrackerCallAt = Date.now();
		if (ctx) {
			config.setLogContext(ctx, {
				tool: toolName,
				issue_key: extractIssueKey(args),
			});
		}
		const startedAt = Date.now();
		try {
			switch (toolName) {
				case "issues_find": {
					const queryText =
						typeof args.query === "string" ? args.query : undefined;
					const perPage = Number(args.per_page ?? args.perPage ?? 100);
					const page = Number(args.page ?? 1);
					const filter =
						args.filter && typeof args.filter === "object"
							? (args.filter as Record<string, unknown>)
							: undefined;
					const queue = typeof args.queue === "string" ? args.queue : undefined;
					const keys =
						Array.isArray(args.keys) || typeof args.keys === "string"
							? (args.keys as string[] | string)
							: undefined;
					const order = typeof args.order === "string" ? args.order : undefined;
					const expand =
						typeof args.expand === "string" || Array.isArray(args.expand)
							? (args.expand as string | string[])
							: undefined;
					const fields =
						typeof args.fields === "string" || Array.isArray(args.fields)
							? (args.fields as string | string[])
							: undefined;
					const result = await trackerIssuesFind({
						query: queryText,
						filter,
						queue,
						keys,
						order,
						expand,
						fields,
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
					const expand =
						typeof args.expand === "string" || Array.isArray(args.expand)
							? (args.expand as string | string[])
							: undefined;
					const fields =
						typeof args.fields === "string" || Array.isArray(args.fields)
							? (args.fields as string | string[])
							: undefined;
					const result = await trackerIssueGet(issueId, timeoutMs, {
						expand,
						fields,
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
				case "issue_get_comments": {
					const issueId = String(args.issue_id ?? "");
					const perPage = Number(args.per_page ?? args.perPage ?? 100);
					const page = Number(args.page ?? 1);
					const result = await trackerIssueGetComments(issueId, timeoutMs, {
						perPage: Number.isFinite(perPage) ? perPage : 100,
						page: Number.isFinite(page) ? page : 1,
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
				case "issue_get_links": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGetLinks(issueId, timeoutMs);
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
				case "issue_get_worklogs": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGetWorklogs(issueId, timeoutMs);
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
				case "issue_get_checklist": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGetChecklist(issueId, timeoutMs);
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
				case "issue_get_transitions": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGetTransitions(issueId, timeoutMs);
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
				case "issue_execute_transition": {
					const issueId = String(args.issue_id ?? "");
					const transitionId = String(
						args.transition_id ?? args.transitionId ?? "",
					);
					const body =
						args.body && typeof args.body === "object"
							? { ...(args.body as Record<string, unknown>) }
							: (() => {
									const copy = { ...args };
									delete copy.issue_id;
									delete copy.transition_id;
									delete copy.transitionId;
									return copy;
								})();
					const result = await trackerIssueExecuteTransition(
						issueId,
						transitionId,
						body,
						timeoutMs,
					);
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
				case "issue_get_attachments": {
					const issueId = String(args.issue_id ?? "");
					const result = await trackerIssueGetAttachments(issueId, timeoutMs);
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
				case "issue_create": {
					const body =
						args.body && typeof args.body === "object"
							? (args.body as Record<string, unknown>)
							: { ...args };
					const result = await trackerIssueCreate(body, timeoutMs);
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
				case "issue_update": {
					const issueId = String(args.issue_id ?? "");
					const body =
						args.body && typeof args.body === "object"
							? (args.body as Record<string, unknown>)
							: (() => {
									const copy = { ...args };
									delete copy.issue_id;
									return copy;
								})();
					const result = await trackerIssueUpdate(issueId, body, timeoutMs);
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
				case "issue_close": {
					const issueId = String(args.issue_id ?? "");
					const resolutionId =
						typeof args.resolution_id === "string"
							? args.resolution_id
							: typeof args.resolutionId === "string"
								? args.resolutionId
								: typeof args.resolution === "string"
									? args.resolution
									: undefined;
					const comment =
						typeof args.comment === "string" ? args.comment : undefined;
					const transitionId =
						typeof args.transition_id === "string"
							? args.transition_id
							: typeof args.transitionId === "string"
								? args.transitionId
								: undefined;
					const transitions = await trackerIssueGetTransitions(
						issueId,
						timeoutMs,
					);
					const transition =
						transitionId ||
						(Array.isArray(transitions)
							? transitions.find((item) => {
									const id =
										typeof item.id === "string" ? item.id.toLowerCase() : "";
									const toKey =
										item.to &&
										typeof (item as { to?: { key?: string } }).to?.key ===
											"string"
											? (
													item as { to?: { key?: string } }
												).to?.key?.toLowerCase()
											: "";
									return (
										id === "close" ||
										id.includes("close") ||
										toKey === "closed" ||
										toKey === "resolved" ||
										toKey === "done"
									);
								})?.id
							: undefined);
					const transitionValue =
						typeof transition === "string" ? transition : "";
					if (!transitionValue) throw new Error("close_transition_not_found");
					const body: Record<string, unknown> = {};
					if (resolutionId) body.resolution = resolutionId;
					if (comment) body.comment = comment;
					const result = await trackerIssueExecuteTransition(
						issueId,
						transitionValue,
						body,
						timeoutMs,
					);
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
				case "issues_count": {
					const body =
						args.body && typeof args.body === "object"
							? (args.body as Record<string, unknown>)
							: (() => {
									const copy: Record<string, unknown> = {};
									if (args.filter && typeof args.filter === "object") {
										copy.filter = args.filter;
									}
									if (typeof args.query === "string") {
										copy.query = args.query;
									}
									return copy;
								})();
					const result = await trackerIssuesCount(body, timeoutMs);
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
				case "queues_get_all": {
					const perPage = Number(args.per_page ?? args.perPage ?? 50);
					const page = Number(args.page ?? 1);
					const expand =
						typeof args.expand === "string" || Array.isArray(args.expand)
							? (args.expand as string | string[])
							: undefined;
					const result = await trackerQueuesGetAll({
						perPage: Number.isFinite(perPage) ? perPage : 50,
						page: Number.isFinite(page) ? page : 1,
						expand,
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
				case "queue_get_metadata": {
					const queueId = String(args.queue_id ?? args.queueId ?? "");
					const expand =
						typeof args.expand === "string" || Array.isArray(args.expand)
							? (args.expand as string | string[])
							: undefined;
					const result = await trackerQueueGetMetadata({
						queueId,
						expand,
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
				case "queue_get_tags": {
					const queueId = String(args.queue_id ?? args.queueId ?? "");
					const result = await trackerQueueGetTags(queueId, timeoutMs);
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
				case "queue_get_versions": {
					const queueId = String(args.queue_id ?? args.queueId ?? "");
					const result = await trackerQueueGetVersions(queueId, timeoutMs);
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
				case "queue_get_fields": {
					const queueId = String(args.queue_id ?? args.queueId ?? "");
					const result = await trackerQueueGetFields(queueId, timeoutMs);
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
				case "users_get_all": {
					const perPage = Number(args.per_page ?? args.perPage ?? 50);
					const page = Number(args.page ?? 1);
					const result = await trackerUsersGetAll({
						perPage: Number.isFinite(perPage) ? perPage : 50,
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
				case "user_get": {
					const userId = String(args.user_id ?? args.userId ?? "");
					const result = await trackerUserGet(userId, timeoutMs);
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
				case "user_get_current": {
					const result = await trackerUserGetCurrent(timeoutMs);
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
				case "users_search": {
					const needle =
						typeof args.login_or_email_or_name === "string"
							? args.login_or_email_or_name
							: typeof args.query === "string"
								? args.query
								: "";
					const perPage = Number(args.per_page ?? args.perPage ?? 50);
					const page = Number(args.page ?? 1);
					const result = await trackerUsersSearch({
						needle,
						perPage: Number.isFinite(perPage) ? perPage : 50,
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
				case "get_global_fields": {
					const result = await trackerGetGlobalFields(timeoutMs);
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
				case "get_statuses": {
					const result = await trackerGetStatuses(timeoutMs);
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
				case "get_issue_types": {
					const result = await trackerGetIssueTypes(timeoutMs);
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
				case "get_priorities": {
					const localized =
						typeof args.localized === "boolean" ? args.localized : undefined;
					const result = await trackerGetPriorities(localized, timeoutMs);
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
				case "get_resolutions": {
					const result = await trackerGetResolutions(timeoutMs);
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

	async function fetchCommentsWithBudget(
		keys: string[],
		commentsByIssue: Record<string, { text: string; truncated: boolean }>,
		deadlineMs: number,
		stats: { fetched: number; cacheHits: number },
		ctx?: BotContext,
	) {
		if (!keys.length) return;
		let cursor = 0;
		const concurrency = Math.max(1, config.commentsFetchConcurrency);

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
						8_000,
						ctx,
					);
					stats.fetched += 1;
					const extracted = extractCommentsText(commentResult);
					commentsByIssue[key] = extracted;
					setCachedComments(key, extracted);
				} catch (error) {
					config.logDebug("issue_get_comments error", {
						key,
						error: String(error),
					});
				}
			}
		};

		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	}

	return {
		trackerCallTool,
		trackerHealthCheck,
		getLastTrackerCallAt: () => lastTrackerCallAt,
		downloadAttachment: trackerDownloadAttachment,
		fetchCommentsWithBudget,
	};
}

export function normalizeIssuesResult(result: TrackerToolResult): {
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

export type RankedIssue = {
	issue: Record<string, unknown>;
	score: number;
	key: string | null;
	index: number;
};

export function getIssueField(
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

export function rankIssues(
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

export function matchesKeywords(text: string, keywords: string[]): boolean {
	const normalizedText = normalizeForMatch(text);
	return (
		keywords.length === 0 ||
		keywords.some((word) => normalizedText.includes(normalizeForMatch(word)))
	);
}

export function extractCommentsText(result: TrackerToolResult): {
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

export function buildIssuesQuery(question: string, queue: string): string {
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
