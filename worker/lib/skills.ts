import type { GatewayConfig } from "../../apps/bot/src/lib/gateway/config.js";
import { resolveToolRef } from "../../apps/bot/src/skills-core.js";

export type SkillStatusConfigCheck = {
	path: string;
	value: unknown;
	satisfied: boolean;
};

export type SkillInstallOption = {
	id: string;
	kind: "brew" | "node" | "go" | "uv";
	label: string;
	bins: string[];
};

export type SkillStatusEntry = {
	name: string;
	description: string;
	source: string;
	server: string;
	filePath: string;
	baseDir: string;
	skillKey: string;
	emoji?: string;
	homepage?: string;
	always: boolean;
	disabled: boolean;
	blockedByAllowlist: boolean;
	eligible: boolean;
	requirements: {
		bins: string[];
		env: string[];
		config: string[];
		os: string[];
	};
	missing: {
		bins: string[];
		env: string[];
		config: string[];
		os: string[];
	};
	configChecks: SkillStatusConfigCheck[];
	install: SkillInstallOption[];
};

export type SkillStatusReport = {
	workspaceDir: string;
	managedSkillsDir: string;
	skills: SkillStatusEntry[];
};

export type SkillConfigEntry = {
	enabled?: boolean;
	env?: Record<string, string>;
};

export type SkillsConfig = {
	entries?: Record<string, SkillConfigEntry>;
};

type RuntimeSkill = {
	name: string;
	description?: string;
	tool: string;
};

const DEFAULT_WORKSPACE_DIR = "apps/bot/skills";
const SKILLS_CONFIG_KEY = "SKILLS_CONFIG" as const;

function parseSkillsConfig(config: GatewayConfig): SkillsConfig {
	const raw = config[SKILLS_CONFIG_KEY];
	if (!raw || typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw) as SkillsConfig;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}

function serializeSkillsConfig(config: SkillsConfig): string {
	return `${JSON.stringify(config ?? {}, null, "\t")}\n`;
}

function resolveSkillRequirements(toolRef: string) {
	const { server } = resolveToolRef(toolRef);
	if (server === "yandex-tracker") {
		return {
			requirements: {
				bins: [],
				env: ["TRACKER_TOKEN", "TRACKER_CLOUD_ORG_ID", "TRACKER_ORG_ID"],
				config: [],
				os: [],
			},
		};
	}
	return {
		requirements: { bins: [], env: [], config: [], os: [] },
	};
}

function buildMissingEnv(params: {
	server: string;
	effectiveEnv: Record<string, string | undefined>;
}) {
	const missing: string[] = [];
	if (params.server === "yandex-tracker") {
		if (!params.effectiveEnv.TRACKER_TOKEN) {
			missing.push("TRACKER_TOKEN");
		}
		const hasOrg =
			Boolean(params.effectiveEnv.TRACKER_CLOUD_ORG_ID) ||
			Boolean(params.effectiveEnv.TRACKER_ORG_ID);
		if (!hasOrg) {
			missing.push("TRACKER_CLOUD_ORG_ID", "TRACKER_ORG_ID");
		}
	}
	return missing;
}

export function buildSkillsStatusReport(params: {
	runtimeSkills: RuntimeSkill[];
	env: Record<string, string | undefined>;
	config: GatewayConfig;
}) {
	const skillsConfig = parseSkillsConfig(params.config);
	const entries = skillsConfig.entries ?? {};
	const skills = params.runtimeSkills.map((skill) => {
		const { server } = resolveToolRef(skill.tool);
		const { requirements } = resolveSkillRequirements(skill.tool);
		const skillKey = `${server}:${skill.name}`;
		const entry = entries[skillKey] ?? {};
		const effectiveEnv: Record<string, string | undefined> = {
			...params.env,
			...(entry.env ?? {}),
		};
		const missingEnv = buildMissingEnv({ server, effectiveEnv });
		const missing = {
			bins: [],
			env: missingEnv,
			config: [],
			os: [],
		};
		const blockedByAllowlist = false;
		const eligible =
			missingEnv.length === 0 && requirements.bins.length === 0 && !blockedByAllowlist;
		const filePath = `skills/${server}/${skill.name}/skill.json`;
		return {
			name: skill.name,
			description: skill.description ?? "",
			source: "bundled",
			server,
			filePath,
			baseDir: `skills/${server}`,
			skillKey,
			always: false,
			disabled: entry.enabled === false,
			blockedByAllowlist,
			eligible,
			requirements,
			missing,
			configChecks: [] as SkillStatusConfigCheck[],
			install: [] as SkillInstallOption[],
		};
	});

	return {
		report: {
			workspaceDir: DEFAULT_WORKSPACE_DIR,
			managedSkillsDir: DEFAULT_WORKSPACE_DIR,
			skills,
		} satisfies SkillStatusReport,
		skillsConfig,
		serializeSkillsConfig,
	};
}

export { parseSkillsConfig, serializeSkillsConfig, SKILLS_CONFIG_KEY };
