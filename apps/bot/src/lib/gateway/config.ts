const GATEWAY_CONFIG_KEYS = [
	"ADMIN_ALLOWLIST",
	"ALLOWED_TG_IDS",
	"ALLOWED_TG_GROUPS",
	"TELEGRAM_GROUP_REQUIRE_MENTION",
	"TELEGRAM_TIMEOUT_SECONDS",
	"TELEGRAM_TEXT_CHUNK_LIMIT",
	"GATEWAY_PLUGINS",
	"GATEWAY_PLUGINS_ALLOWLIST",
	"GATEWAY_PLUGINS_DENYLIST",
	"CRON_STATUS_ENABLED",
	"CRON_STATUS_CHAT_ID",
	"CRON_STATUS_TIMEZONE",
	"CRON_STATUS_SPRINT_FILTER",
	"CRON_STATUS_MAX_ITEMS_PER_SECTION",
	"CRON_STATUS_SUMMARY_ENABLED",
	"CRON_STATUS_SUMMARY_MODEL",
	"CRON_STATUS_IN_PROGRESS_STATUSES",
	"CRON_STATUS_BLOCKED_STATUSES",
	"CRON_TEAM_AI_ASSIGNEES",
	"CRON_TEAM_CS_ASSIGNEES",
	"CRON_TEAM_HR_ASSIGNEES",
] as const;

type GatewayConfigKey = (typeof GATEWAY_CONFIG_KEYS)[number];
type GatewayConfig = Partial<Record<GatewayConfigKey, string>>;

function sanitizeGatewayConfig(input: unknown): GatewayConfig {
	const next: GatewayConfig = {};
	if (!input || typeof input !== "object") return next;
	for (const key of GATEWAY_CONFIG_KEYS) {
		const raw = (input as Record<string, unknown>)[key];
		if (typeof raw === "string") {
			next[key] = raw;
		}
	}
	return next;
}

function applyGatewayConfig(
	env: Record<string, string | undefined>,
	config: GatewayConfig,
) {
	const next = { ...env };
	for (const [key, value] of Object.entries(config)) {
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (trimmed) {
			next[key as GatewayConfigKey] = trimmed;
		}
	}
	return next;
}

function buildGatewayConfigSnapshot(
	env: Record<string, string | undefined>,
	config: GatewayConfig,
): GatewayConfig {
	const snapshot: GatewayConfig = {};
	for (const key of GATEWAY_CONFIG_KEYS) {
		const stored = config[key];
		if (typeof stored === "string" && stored.trim()) {
			snapshot[key] = stored;
		} else if (env[key] !== undefined) {
			snapshot[key] = env[key];
		} else {
			snapshot[key] = "";
		}
	}
	return snapshot;
}

export {
	GATEWAY_CONFIG_KEYS,
	type GatewayConfig,
	type GatewayConfigKey,
	applyGatewayConfig,
	buildGatewayConfigSnapshot,
	sanitizeGatewayConfig,
};
