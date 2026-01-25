type JiraIssueFields = {
	key: string;
	summary: string;
	status: string;
	assignee: string;
	priority: string;
	updated: string;
};

type TeamConfig = {
	name: string;
	assignees: string[];
};

type JiraClientConfig = {
	baseUrl: string;
	email: string;
	apiToken: string;
	projectKey: string;
};

const DEFAULT_IN_PROGRESS_STATUSES = [
	"In Progress",
	"In Review",
	"Ready for QA",
	"In QA",
	"Ready for Release",
	"Ready for release",
];

const DEFAULT_BLOCKED_STATUSES = ["Blocked", "Dev Blocked", "QA Blocked"];
const DEFAULT_MAX_ITEMS_PER_SECTION = 0;

const DEFAULT_TEAM_CONFIGS: TeamConfig[] = [
	{ name: "AI team", assignees: ["Vitaly Zadorozhny"] },
	{
		name: "CS team",
		assignees: ["Mikhail Shpakov", "Dmitrii Pletnev", "Andrey Pozdnyshev"],
	},
	{ name: "HR team", assignees: ["Dmitry Zorin", "Ponosov Alexandr"] },
];

function parseAssignees(raw?: string): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function resolveTeams(env: Record<string, string | undefined>): TeamConfig[] {
	const ai = parseAssignees(env.CRON_TEAM_AI_ASSIGNEES);
	const cs = parseAssignees(env.CRON_TEAM_CS_ASSIGNEES);
	const hr = parseAssignees(env.CRON_TEAM_HR_ASSIGNEES);
	if (ai.length || cs.length || hr.length) {
		return [
			{ name: "AI team", assignees: ai },
			{ name: "CS team", assignees: cs },
			{ name: "HR team", assignees: hr },
		].filter((team) => team.assignees.length > 0);
	}
	return DEFAULT_TEAM_CONFIGS;
}

function escapeJqlString(value: string): string {
	return value.replaceAll('"', '\\"');
}

function buildAssigneeClause(assignees: string[]): string {
	if (!assignees.length) return "";
	const values = assignees
		.map((name) => `"${escapeJqlString(name)}"`)
		.join(", ");
	return `assignee in (${values})`;
}

function buildStatusClause(statuses: string[]): string {
	if (!statuses.length) return "";
	const values = statuses
		.map((name) => `"${escapeJqlString(name)}"`)
		.join(", ");
	return `status in (${values})`;
}

function joinClauses(clauses: string[]): string {
	return clauses.filter(Boolean).join(" AND ");
}

function resolveSprintClause(env: Record<string, string | undefined>) {
	const raw = env.CRON_STATUS_SPRINT_CLAUSE?.trim();
	if (raw) return raw;
	const mode = (env.CRON_STATUS_SPRINT_FILTER ?? "open").trim().toLowerCase();
	if (mode === "off" || mode === "0" || mode === "false") return "";
	return "sprint in openSprints()";
}

async function jiraSearch(
	client: JiraClientConfig,
	jql: string,
	maxResults = 50,
): Promise<JiraIssueFields[]> {
	const url = new URL("/rest/api/3/search/jql", client.baseUrl);
	url.searchParams.set("jql", jql);
	url.searchParams.set("fields", "summary,status,assignee,priority,updated");
	url.searchParams.set("maxResults", String(maxResults));
	const auth =
		typeof btoa === "function"
			? btoa(`${client.email}:${client.apiToken}`)
			: Buffer.from(`${client.email}:${client.apiToken}`, "utf8").toString(
					"base64",
				);
	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Basic ${auth}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`jira_search_failed:${response.status}:${response.statusText}:${body}`,
		);
	}
	const data = (await response.json()) as {
		issues?: Array<{
			key?: string;
			fields?: {
				summary?: string;
				status?: { name?: string };
				assignee?: { displayName?: string };
				priority?: { name?: string };
				updated?: string;
			};
		}>;
	};
	return (data.issues ?? []).map((issue) => ({
		key: issue.key ?? "",
		summary: issue.fields?.summary ?? "",
		status: issue.fields?.status?.name ?? "",
		assignee: issue.fields?.assignee?.displayName ?? "",
		priority: issue.fields?.priority?.name ?? "",
		updated: issue.fields?.updated ?? "",
	}));
}

function formatTeamBlock(params: {
	team: string;
	progressText: string;
	inProgressText: string;
	blockersText: string;
}): string {
	const lines = [
		`**${params.team}**`,
		"",
		`Прогресс за вчера:`,
		"",
		params.progressText || "Нет значимых изменений.",
		"",
		`Сейчас в работе:`,
		"",
		params.inProgressText || "Нет активных задач.",
		"",
		`Блокеры/риски:`,
		"",
		params.blockersText || "Нет.",
	];
	return lines.join("\n").trim();
}

function formatDateLabel(date: Date, timeZone: string): string {
	const formatter = new Intl.DateTimeFormat("ru-RU", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return formatter.format(date);
}

export async function buildDailyStatusReportParts(params: {
	env: Record<string, string | undefined>;
	now?: Date;
}): Promise<{ header: string; blocks: string[] }> {
	const env = params.env;
	const baseUrl = env.JIRA_BASE_URL ?? "";
	const email = env.JIRA_EMAIL ?? "";
	const apiToken = env.JIRA_API_TOKEN ?? "";
	const openaiApiKey = env.OPENAI_API_KEY ?? "";
	const summaryEnabled = env.CRON_STATUS_SUMMARY_ENABLED === "1";
	const summaryModel =
		env.CRON_STATUS_SUMMARY_MODEL?.trim() || env.OPENAI_MODEL || "gpt-5.2";
	const projectKey = env.JIRA_PROJECT_KEY ?? "FL";
	if (!baseUrl || !email || !apiToken) {
		throw new Error("jira_not_configured");
	}
	if (!summaryEnabled) {
		throw new Error("summary_required");
	}
	if (!openaiApiKey) {
		throw new Error("openai_not_configured");
	}
	const client: JiraClientConfig = { baseUrl, email, apiToken, projectKey };
	const timeZone = env.CRON_STATUS_TIMEZONE ?? "Europe/Moscow";
	const teams = resolveTeams(env);
	const sprintClause = resolveSprintClause(env);
	const inProgressStatuses = parseAssignees(
		env.CRON_STATUS_IN_PROGRESS_STATUSES,
	);
	const blockedStatuses = parseAssignees(env.CRON_STATUS_BLOCKED_STATUSES);
	const progressStatuses =
		inProgressStatuses.length > 0
			? inProgressStatuses
			: DEFAULT_IN_PROGRESS_STATUSES;
	const blocked =
		blockedStatuses.length > 0 ? blockedStatuses : DEFAULT_BLOCKED_STATUSES;
	const maxItems = Number.parseInt(
		env.CRON_STATUS_MAX_ITEMS_PER_SECTION ?? "",
		10,
	);
	const maxPerSection =
		Number.isFinite(maxItems) && maxItems >= 0
			? maxItems
			: DEFAULT_MAX_ITEMS_PER_SECTION;
	const now = params.now ?? new Date();
	const headerDate = formatDateLabel(now, timeZone);

	const blocks: string[] = [];

	for (const team of teams) {
		const assigneeClause = buildAssigneeClause(team.assignees);
		const baseClauses = [
			`project = ${projectKey}`,
			assigneeClause,
			sprintClause,
		];
		const progressJql = joinClauses([
			...baseClauses,
			"updated >= startOfDay(-1d)",
			"updated < startOfDay()",
		]);
		const nowJql = joinClauses([
			...baseClauses,
			buildStatusClause(progressStatuses),
		]);
		const blockerJql = joinClauses([
			...baseClauses,
			`(${buildStatusClause(blocked)} OR priority = High)`,
		]);

		const [progressIssues, nowIssues, blockerIssues] = await Promise.all([
			jiraSearch(client, progressJql, 30),
			jiraSearch(client, nowJql, 30),
			jiraSearch(client, blockerJql, 30),
		]);

		const progressSlice = maxPerSection
			? progressIssues.slice(0, maxPerSection)
			: progressIssues;
		const nowSlice = maxPerSection
			? nowIssues.slice(0, maxPerSection)
			: nowIssues;
		const blockerSlice = maxPerSection
			? blockerIssues.slice(0, maxPerSection)
			: blockerIssues;
		const summary = await summarizeTeam({
			apiKey: openaiApiKey,
			model: summaryModel,
			team: team.name,
			progress: progressSlice,
			inProgress: nowSlice,
			blockers: blockerSlice,
		});
		const teamBlock = formatTeamBlock(summary);
		blocks.push(teamBlock);
	}

	const header = `**Ежедневный статус (${headerDate})**`;
	return { header, blocks };
}

export async function buildDailyStatusReport(params: {
	env: Record<string, string | undefined>;
	now?: Date;
}): Promise<string> {
	const { header, blocks } = await buildDailyStatusReportParts(params);
	return [header, "", ...blocks].join("\n\n").trim();
}

async function summarizeTeam(params: {
	apiKey: string;
	model: string;
	team: string;
	progress: JiraIssueFields[];
	inProgress: JiraIssueFields[];
	blockers: JiraIssueFields[];
}): Promise<{
	team: string;
	progressText: string;
	inProgressText: string;
	blockersText: string;
}> {
	const prompt = buildSummaryPrompt(params);
	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: params.model,
			input: prompt,
			max_output_tokens: 120,
		}),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`openai_summary_failed:${response.status}:${response.statusText}:${body}`,
		);
	}
	const data = (await response.json()) as {
		output_text?: string;
		output?: Array<{ content?: Array<{ text?: string }> }>;
	};
	const raw =
		data.output_text ??
		data.output
			?.flatMap((item) => item.content ?? [])
			.map((item) => item.text ?? "")
			.join(" ") ??
		"";
	const trimmed = raw.trim();
	const parts = trimmed
		.split("\n\n")
		.map((part) => part.trim())
		.filter(Boolean);
	const [progressText, inProgressText, blockersText] = [
		parts[0] ?? "",
		parts[1] ?? "",
		parts[2] ?? "",
	];
	return {
		team: params.team,
		progressText,
		inProgressText,
		blockersText,
	};
}

function buildSummaryPrompt(params: {
	team: string;
	progress: JiraIssueFields[];
	inProgress: JiraIssueFields[];
	blockers: JiraIssueFields[];
}) {
	const formatList = (title: string, issues: JiraIssueFields[]) => {
		if (!issues.length) return `${title}: нет`;
		const lines = issues.map(
			(issue) => `- ${issue.key}: ${issue.summary} (${issue.status})`,
		);
		return `${title}:\n${lines.join("\n")}`;
	};
	return [
		`Ты готовишь статус для CEO по команде "${params.team}" на русском.`,
		"Нужно 3 коротких абзаца, без списков, без заголовков и без технических деталей.",
		"Каждый абзац — это перефразированное содержание соответствующего раздела.",
		"Абзацы строго в порядке: Прогресс за вчера, Сейчас в работе, Блокеры/риски.",
		"Верни только 3 абзаца и ничего больше.",
		formatList("Прогресс за вчера", params.progress),
		formatList("Сейчас в работе", params.inProgress),
		formatList("Блокеры/риски", params.blockers),
	].join("\n\n");
}
