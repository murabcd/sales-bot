type AdminStatus = {
	serviceName: string;
	version: string;
	commit: string;
	region: string;
	instanceId: string;
	uptimeSeconds: number;
	sessions?: {
		gatewayConnections: number;
		activeStreams: number;
	};
	admin: {
		authRequired: boolean;
		allowlist: string[];
	};
	gateway?: undefined;
	cron: {
		enabled: boolean;
		chatId: string;
		timezone: string;
		sprintFilter: string;
	};
	summary: {
		enabled: boolean;
		model: string;
	};
};

function parseList(raw: string | undefined) {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function authorizeGatewayToken(params: {
	token?: string;
	expectedToken?: string;
	allowlist?: string;
	clientIp?: string;
}) {
	const expected = params.expectedToken?.trim() ?? "";
	if (!expected) return false;
	if (!params.token || params.token !== expected) return false;
	const allowlist = parseList(params.allowlist);
	if (allowlist.length === 0) return true;
	return Boolean(params.clientIp && allowlist.includes(params.clientIp));
}

function buildAdminStatusPayload(params: {
	env: Record<string, string | undefined>;
	uptimeSeconds: number;
	sessions?: { gatewayConnections: number; activeStreams: number };
}): AdminStatus {
	const env = params.env;
	return {
		serviceName: env.SERVICE_NAME ?? "omni",
		version: env.RELEASE_VERSION ?? "dev",
		commit: env.COMMIT_HASH ?? "local",
		region: env.REGION ?? "local",
		instanceId: env.INSTANCE_ID ?? "local",
		uptimeSeconds: params.uptimeSeconds,
		sessions: params.sessions,
		admin: {
			authRequired: Boolean(env.ADMIN_API_TOKEN?.trim()),
			allowlist: parseList(env.ADMIN_ALLOWLIST),
		},
		cron: {
			enabled: env.CRON_STATUS_ENABLED === "1",
			chatId: env.CRON_STATUS_CHAT_ID ?? "",
			timezone: env.CRON_STATUS_TIMEZONE ?? "Europe/Moscow",
			sprintFilter: env.CRON_STATUS_SPRINT_FILTER ?? "open",
		},
		summary: {
			enabled: env.CRON_STATUS_SUMMARY_ENABLED === "1",
			model: env.CRON_STATUS_SUMMARY_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
		},
	};
}

export { authorizeGatewayToken, buildAdminStatusPayload, parseList };
export type { AdminStatus };
