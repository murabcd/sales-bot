import { regex } from "arkregex";
import type { Bot, InlineKeyboard } from "grammy";
import type { ModelsFile } from "../../models-core.js";
import type { RuntimeSkill } from "../../skills-core.js";
import type { ChannelConfig } from "../channels.js";
import type { ApprovalStore } from "../tools/approvals.js";
import type { ToolPolicy } from "../tools/policy.js";
import type { ToolConflict, ToolMeta } from "../tools/registry.js";
import { findCronJob, formatCronJob } from "./cron.js";
import type { BotContext, LogContext } from "./types.js";

type CommandDeps = {
	bot: Bot<BotContext>;
	startGreeting: string;
	startKeyboard: InlineKeyboard;
	sendText: (
		ctx: {
			reply: (
				text: string,
				options?: Record<string, unknown>,
			) => Promise<unknown>;
		},
		text: string,
		options?: Record<string, unknown>,
	) => Promise<void>;
	logDebug: (message: string, data?: unknown) => void;
	clearHistoryMessages: () => void;
	setLogContext: (ctx: BotContext, update: Partial<LogContext>) => void;
	getCommandTools: () => Promise<ToolMeta[]>;
	resolveChatToolPolicy: (ctx: BotContext) => ToolPolicy | undefined;
	toolPolicy: ToolPolicy | undefined;
	mergeToolPolicies: (
		base?: ToolPolicy,
		extra?: ToolPolicy,
	) => ToolPolicy | undefined;
	filterToolMetasByPolicy: (
		tools: ToolMeta[],
		policy?: ToolPolicy,
	) => ToolMeta[];
	TOOL_CONFLICTS: ToolConflict[];
	TOOL_SUPPRESSED_BY_POLICY: string[];
	approvalRequired: Set<string>;
	approvalStore: ApprovalStore;
	listApprovals: (
		store: ApprovalStore,
		chatId: string,
	) => Array<{ tool: string; expiresAt: number }>;
	parseToolRateLimits: (
		raw: string,
	) => Array<{ tool: string; max: number; windowSeconds: number }>;
	TOOL_RATE_LIMITS: string;
	normalizeToolName: (value: string) => string;
	runtimeSkills: RuntimeSkill[];
	filterSkillsForChannel: (options: {
		skills: RuntimeSkill[];
		channelConfig?: ChannelConfig;
	}) => RuntimeSkill[];
	resolveToolRef: (value: string) => { server?: string; tool?: string };
	trackerCallTool: (
		toolName: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		ctx?: BotContext,
	) => Promise<unknown>;
	formatToolResult: (result: unknown) => string;
	getActiveModelRef: () => string;
	getActiveModelFallbacks: () => string[];
	resolveReasoning: () => string;
	setActiveModel: (ref: string) => void;
	setActiveReasoningOverride: (value: string | null) => void;
	normalizeModelRef: (ref: string) => string;
	normalizeReasoning: (value: string) => string | null;
	modelsConfig: ModelsFile;
	isGroupChat: (ctx: BotContext) => boolean;
	shouldRequireMentionForChannel: (options: {
		channelConfig?: ChannelConfig;
		defaultRequireMention: boolean;
	}) => boolean;
	isReplyToBotWithoutMention: (ctx: BotContext) => boolean;
	isBotMentioned: (ctx: BotContext) => boolean;
	TELEGRAM_GROUP_REQUIRE_MENTION: boolean;
	withTimeout: <T>(
		promise: Promise<T>,
		ms: number,
		label: string,
	) => Promise<T>;
	trackerHealthCheck: () => Promise<unknown>;
	formatUptime: (seconds: number) => string;
	getUptimeSeconds?: () => number;
	getLastTrackerCallAt: () => number | null;
	jiraEnabled?: boolean;
	posthogEnabled?: boolean;
	webSearchEnabled?: boolean;
	memoryEnabled?: boolean;
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
	defaultCronTimezone: string;
	getChatTimezoneOverride: (ctx: BotContext) => Promise<string | undefined>;
	setChatTimezone: (
		ctx: BotContext,
		timeZone: string | null,
	) => Promise<boolean>;
};

export function registerCommands(deps: CommandDeps) {
	const HELP_STATUS_CMD_RE = regex("^cmd:(help|commands|status)$");
	const {
		bot,
		startGreeting,
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
		getActiveModelRef,
		getActiveModelFallbacks,
		resolveReasoning,
		setActiveModel,
		setActiveReasoningOverride,
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
		getUptimeSeconds,
		jiraEnabled,
		posthogEnabled,
		webSearchEnabled,
		memoryEnabled,
		cronClient,
		defaultCronTimezone,
		getChatTimezoneOverride,
		setChatTimezone,
	} = deps;

	bot.command("start", (ctx) => {
		setLogContext(ctx, { command: "/start", message_type: "command" });
		const memoryId = ctx.from?.id?.toString() ?? "";
		if (memoryId) {
			clearHistoryMessages();
		}
		return sendText(ctx, startGreeting, { reply_markup: startKeyboard });
	});

	async function handleHelp(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		await sendText(
			ctx,
			"Я Omni — помогаю с задачами, аналитикой и поиском.\n\n" +
				"Умею:\n" +
				"— отчеты и напоминания по расписанию\n" +
				"— Jira / Yandex Tracker\n" +
				"— PostHog аналитика\n" +
				"— поиск в интернете\n\n" +
				"Примеры:\n" +
				'"Сделай ежедневный отчет по PostHog в 11:00"\n' +
				'"Проверь статус PROJ-1234 в Tracker"\n' +
				'"Есть ли блокеры в текущем спринте Jira?"\n' +
				'"Найди ближайшие HR-конференции в РФ"',
		);
	}

	async function handleCommands(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		await sendText(
			ctx,
			"Команды:\n" +
				"— /start — начать сначала\n" +
				"— /commands — список команд\n" +
				"— /status — проверить работу бота\n" +
				"— /cron — управление расписаниями\n" +
				"— /timezone — установить или посмотреть часовой пояс\n" +
				"— /help — описание возможностей\n\n",
		);
	}

	bot.command("help", (ctx) => {
		setLogContext(ctx, { command: "/help", message_type: "command" });
		return handleHelp(ctx);
	});

	bot.command("commands", (ctx) => {
		setLogContext(ctx, { command: "/commands", message_type: "command" });
		return handleCommands(ctx);
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
			const fallbacks = getActiveModelFallbacks().length
				? getActiveModelFallbacks().join(", ")
				: "none";
			await sendText(
				ctx,
				`Model: ${getActiveModelRef()}\nReasoning: ${resolveReasoning()}\nFallbacks: ${fallbacks}`,
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
				await sendText(ctx, `Model set to ${getActiveModelRef()}`);
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
			setActiveReasoningOverride(normalized);
			await sendText(ctx, `Reasoning set to ${normalized}`);
			return;
		}

		await sendText(ctx, "Unknown /model subcommand");
	});

	bot.command("skills", async (ctx) => {
		setLogContext(ctx, { command: "/skills", message_type: "command" });
		const channelSkills = filterSkillsForChannel({
			skills: runtimeSkills,
			channelConfig: ctx.state.channelConfig,
		});
		const channelSupported = filterSkillsForChannel({
			skills: runtimeSkills,
			channelConfig: ctx.state.channelConfig,
		});
		if (!channelSkills.length) {
			await sendText(ctx, "Нет доступных runtime-skills.");
			return;
		}
		const supported = new Set(channelSupported.map((skill) => skill.name));
		const lines = channelSkills.map((skill) => {
			const desc = skill.description ? ` - ${skill.description}` : "";
			const suffix = supported.has(skill.name) ? "" : " (blocked)";
			return `${skill.name}${suffix}${desc}`;
		});
		await sendText(ctx, `Доступные runtime-skills:\n${lines.join("\n")}`);
	});

	bot.command("skill", async (ctx) => {
		setLogContext(ctx, { command: "/skill", message_type: "command" });
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
		const text = ctx.message?.text ?? "";
		const [, skillName, ...rest] = text.split(" ");
		if (!skillName) {
			await sendText(ctx, "Использование: /skill <name> <json>");
			return;
		}
		const channelSupported = filterSkillsForChannel({
			skills: runtimeSkills,
			channelConfig: ctx.state.channelConfig,
		});
		const skill = channelSupported.find((item) => item.name === skillName);
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
		const ALLOWED_SKILL_SERVERS = new Set([
			"yandex-tracker",
			"jira",
			"web",
			"memory",
			"posthog",
		]);
		if (!server || !ALLOWED_SKILL_SERVERS.has(server)) {
			await sendText(ctx, `Неподдерживаемый tool server: ${server}`);
			return;
		}

		try {
			if (server === "yandex-tracker" || server === "tracker") {
				const result = await trackerCallTool(
					tool,
					mergedArgs,
					skill.timeoutMs ?? 8_000,
					ctx,
				);
				const text = formatToolResult(result);
				if (text) {
					await sendText(ctx, text);
					return;
				}
				await sendText(ctx, "Skill выполнился, но не вернул текст.");
				return;
			}
			await sendText(
				ctx,
				`Инструменты сервера ${server} пока не поддерживаются в /skill.`,
			);
			return;
		} catch (error) {
			await sendText(ctx, `Ошибка вызова skill: ${String(error)}`);
		}
	});

	function shouldBlockCommand(ctx: BotContext) {
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
				return true;
			}
		}
		return false;
	}

	type CronResolution =
		| {
				id: string;
				job?: unknown;
				error?: undefined;
		  }
		| {
				error: "cron_not_configured" | "not_found" | "ambiguous";
				id?: undefined;
				job?: undefined;
		  };

	async function resolveCronJobTarget(target: string): Promise<CronResolution> {
		if (!cronClient) return { error: "cron_not_configured" };
		const payload = await cronClient.list({ includeDisabled: true });
		const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
		const matches = findCronJob(jobs, target);
		if (matches.length === 0) return { error: "not_found" };
		if (matches.length > 1) return { error: "ambiguous" };
		const job = matches[0] as { id?: string };
		return { id: job.id ?? target, job };
	}

	bot.command("timezone", async (ctx) => {
		setLogContext(ctx, { command: "/timezone", message_type: "command" });
		if (shouldBlockCommand(ctx)) return;
		if (!setChatTimezone) {
			await sendText(ctx, "Timezone storage is not configured.");
			return;
		}
		const text = ctx.message?.text ?? "";
		const parts = text.split(" ");
		const raw = parts.slice(1).join(" ").trim();
		if (!raw) {
			const override = await getChatTimezoneOverride(ctx);
			const value = override ?? defaultCronTimezone;
			const suffix = override ? " (custom)" : " (default)";
			await sendText(ctx, `Timezone: ${value}${suffix}`);
			return;
		}
		if (raw === "reset" || raw === "default") {
			const ok = await setChatTimezone(ctx, null);
			await sendText(
				ctx,
				ok
					? `Timezone reset to default (${defaultCronTimezone}).`
					: "Failed to reset timezone.",
			);
			return;
		}
		const ok = await setChatTimezone(ctx, raw);
		await sendText(
			ctx,
			ok ? `Timezone set to ${raw}.` : "Failed to set timezone.",
		);
	});

	bot.command("cron", async (ctx) => {
		setLogContext(ctx, { command: "/cron", message_type: "command" });
		if (shouldBlockCommand(ctx)) return;
		if (!cronClient) {
			await sendText(ctx, "Cron is not configured.");
			return;
		}
		const text = ctx.message?.text ?? "";
		const parts = text.split(" ");
		const sub = parts[1]?.trim().toLowerCase() ?? "";
		const rest = parts.slice(2).join(" ").trim();

		if (!sub || sub === "help") {
			await sendText(
				ctx,
				"Использование:\n" +
					"/cron list\n" +
					"/cron status [id|name]\n" +
					"/cron runs <id|name>\n" +
					"/cron run <id|name>\n" +
					"/cron stop <id|name>\n" +
					"/cron start <id|name>\n" +
					"/cron remove <id|name>\n" +
					"/cron edit <id|name> cron <expr> [tz]\n" +
					"/cron edit <id|name> every <minutes>",
			);
			return;
		}

		if (sub === "list") {
			const payload = await cronClient.list({ includeDisabled: true });
			const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
			if (jobs.length === 0) {
				await sendText(ctx, "No cron jobs.");
				return;
			}
			const lines = jobs.map((job) => formatCronJob(job));
			await sendText(ctx, lines.join("\n"));
			return;
		}

		if (sub === "status") {
			if (!rest) {
				const status = await cronClient.status();
				await sendText(ctx, JSON.stringify(status, null, 2));
				return;
			}
			const resolved = await resolveCronJobTarget(rest);
			if (resolved.error === "not_found") {
				await sendText(ctx, `No job found for ${rest}.`);
				return;
			}
			if (resolved.error === "ambiguous") {
				await sendText(ctx, "Multiple matches found. Please specify a job id.");
				return;
			}
			if (resolved.error) {
				await sendText(ctx, "Cron is not configured.");
				return;
			}
			await sendText(ctx, formatCronJob(resolved.job));
			return;
		}

		if (sub === "runs") {
			if (!rest) {
				await sendText(ctx, "Usage: /cron runs <id|name>");
				return;
			}
			const resolved = await resolveCronJobTarget(rest);
			if (resolved.error === "not_found") {
				await sendText(ctx, `No job found for ${rest}.`);
				return;
			}
			if (resolved.error === "ambiguous") {
				await sendText(ctx, "Multiple matches found. Please specify a job id.");
				return;
			}
			if (resolved.error) {
				await sendText(ctx, "Cron is not configured.");
				return;
			}
			const runs = await cronClient.runs({ id: resolved.id, limit: 10 });
			await sendText(ctx, JSON.stringify(runs, null, 2));
			return;
		}

		if (sub === "run") {
			if (!rest) {
				await sendText(ctx, "Usage: /cron run <id|name>");
				return;
			}
			const resolved = await resolveCronJobTarget(rest);
			if (resolved.error === "not_found") {
				await sendText(ctx, `No job found for ${rest}.`);
				return;
			}
			if (resolved.error === "ambiguous") {
				await sendText(ctx, "Multiple matches found. Please specify a job id.");
				return;
			}
			if (resolved.error) {
				await sendText(ctx, "Cron is not configured.");
				return;
			}
			await cronClient.run({ jobId: resolved.id, mode: "force" });
			await sendText(ctx, `Triggered ${resolved.id}.`);
			return;
		}

		if (
			sub === "stop" ||
			sub === "start" ||
			sub === "enable" ||
			sub === "disable"
		) {
			if (!rest) {
				await sendText(ctx, `Usage: /cron ${sub} <id|name>`);
				return;
			}
			const resolved = await resolveCronJobTarget(rest);
			if (resolved.error === "not_found") {
				await sendText(ctx, `No job found for ${rest}.`);
				return;
			}
			if (resolved.error === "ambiguous") {
				await sendText(ctx, "Multiple matches found. Please specify a job id.");
				return;
			}
			if (resolved.error) {
				await sendText(ctx, "Cron is not configured.");
				return;
			}
			const enabled = sub === "start" || sub === "enable";
			const updated = await cronClient.update({
				id: resolved.id,
				patch: { enabled },
			});
			await sendText(
				ctx,
				updated ? `Updated: ${formatCronJob(updated)}` : "Updated.",
			);
			return;
		}

		if (sub === "remove" || sub === "delete") {
			if (!rest) {
				await sendText(ctx, `Usage: /cron ${sub} <id|name>`);
				return;
			}
			const resolved = await resolveCronJobTarget(rest);
			if (resolved.error === "not_found") {
				await sendText(ctx, `No job found for ${rest}.`);
				return;
			}
			if (resolved.error === "ambiguous") {
				await sendText(ctx, "Multiple matches found. Please specify a job id.");
				return;
			}
			if (resolved.error) {
				await sendText(ctx, "Cron is not configured.");
				return;
			}
			await cronClient.remove({ jobId: resolved.id });
			await sendText(ctx, `Removed ${resolved.id}.`);
			return;
		}

		if (sub === "edit") {
			const editParts = rest.split(" ");
			const target = editParts.shift()?.trim() ?? "";
			const mode = editParts.shift()?.trim()?.toLowerCase() ?? "";
			if (!target || !mode) {
				await sendText(
					ctx,
					"Usage: /cron edit <id|name> cron <expr> [tz] | /cron edit <id|name> every <minutes>",
				);
				return;
			}
			const resolved = await resolveCronJobTarget(target);
			if (resolved.error === "not_found") {
				await sendText(ctx, `No job found for ${target}.`);
				return;
			}
			if (resolved.error === "ambiguous") {
				await sendText(ctx, "Multiple matches found. Please specify a job id.");
				return;
			}
			if (resolved.error) {
				await sendText(ctx, "Cron is not configured.");
				return;
			}
			if (mode === "every") {
				const minutesRaw = editParts[0] ?? "";
				const minutes = Number.parseInt(minutesRaw, 10);
				if (!Number.isFinite(minutes) || minutes <= 0) {
					await sendText(ctx, "Invalid minutes for every cadence.");
					return;
				}
				const updated = await cronClient.update({
					id: resolved.id,
					patch: { schedule: { kind: "every", everyMs: minutes * 60_000 } },
				});
				await sendText(
					ctx,
					updated ? `Updated: ${formatCronJob(updated)}` : "Updated.",
				);
				return;
			}
			if (mode === "cron") {
				const tz = editParts[editParts.length - 1];
				const expr =
					editParts.length > 1
						? editParts.slice(0, -1).join(" ")
						: editParts.join(" ");
				if (!expr.trim()) {
					await sendText(ctx, "Missing cron expression.");
					return;
				}
				const updated = await cronClient.update({
					id: resolved.id,
					patch: {
						schedule: {
							kind: "cron",
							expr: expr.trim(),
							tz: tz?.includes("/") ? tz : undefined,
						},
					},
				});
				await sendText(
					ctx,
					updated ? `Updated: ${formatCronJob(updated)}` : "Updated.",
				);
				return;
			}
			await sendText(ctx, "Unknown edit mode. Use 'cron' or 'every'.");
			return;
		}

		await sendText(ctx, "Unknown /cron subcommand. Use /cron help.");
	});

	async function handleStatus(ctx: {
		reply: (text: string) => Promise<unknown>;
	}) {
		const uptimeSeconds = getUptimeSeconds?.() ?? 0;
		const uptime = formatUptime(uptimeSeconds);
		let trackerStatus = "ok";
		try {
			await withTimeout(trackerHealthCheck(), 5_000, "trackerHealthCheck");
		} catch (error) {
			trackerStatus = `error: ${String(error)}`;
		}

		const lines = [
			"Статус:",
			`— аптайм: ${uptime}`,
			`— модель: ${getActiveModelRef()}`,
			`— yandex-tracker: ${trackerStatus}`,
			`— jira: ${jiraEnabled ? "ok" : "не настроен"}`,
			`— posthog: ${posthogEnabled ? "ok" : "не настроен"}`,
			`— веб-поиск: ${webSearchEnabled ? "включён" : "выключен"}`,
			`— память: ${memoryEnabled ? "ok" : "не настроена"}`,
		];
		await sendText(ctx, lines.join("\n"));
	}

	bot.command("status", (ctx) => {
		setLogContext(ctx, { command: "/status", message_type: "command" });
		return handleStatus(ctx);
	});

	bot.command("whoami", (ctx) => {
		setLogContext(ctx, { command: "/whoami", message_type: "command" });
		return sendText(
			ctx,
			"Я Omni, персональный ассистент для задач, аналитики и поиска информации.",
		);
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

	async function refreshInlineKeyboard(ctx: {
		editMessageReplyMarkup: (options: {
			reply_markup: InlineKeyboard;
		}) => Promise<unknown>;
	}) {
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

	bot.callbackQuery(HELP_STATUS_CMD_RE, async (ctx) => {
		setLogContext(ctx, { message_type: "callback" });
		await safeAnswerCallback(ctx);
		const command = ctx.match?.[1];
		if (command === "help") {
			setLogContext(ctx, { command: "cmd:help" });
			await handleHelp(ctx);
			await refreshInlineKeyboard(ctx);
			return;
		}
		if (command === "commands") {
			setLogContext(ctx, { command: "cmd:commands" });
			await handleCommands(ctx);
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
}
