import { type RuntimeSkill, resolveToolRef } from "../../skills-core.js";

const SKILL_PATH_BY_SERVER: Record<string, string> = {
	"yandex-tracker": "apps/bot/skills/yandex-tracker/SKILL.md",
	"yandex-wiki": "apps/bot/skills/yandex-wiki/SKILL.md",
	jira: "apps/bot/skills/jira/SKILL.md",
	posthog: "apps/bot/skills/posthog/SKILL.md",
	figma: "apps/bot/skills/figma/SKILL.md",
	"google-public": "apps/bot/skills/google-public/SKILL.md",
	memory: "apps/bot/skills/memory/SKILL.md",
	web: "apps/bot/skills/web/SKILL.md",
};

const SKILL_DESCRIPTION_BY_SERVER: Record<string, string> = {
	"yandex-tracker": "Yandex Tracker issues and workflows.",
	"yandex-wiki": "Yandex Wiki pages and docs.",
	jira: "Jira issues and sprints.",
	posthog: "PostHog analytics and insights.",
	figma: "Figma files, nodes, and comments.",
	"google-public": "Read public Google Docs/Sheets.",
	memory: "Long-term memory search and storage.",
	web: "Web search for up-to-date info.",
};

export function buildSkillsPrompt(skills: RuntimeSkill[]) {
	if (skills.length === 0) return "";
	const servers = new Map<
		string,
		{ name: string; description: string; path: string }
	>();
	for (const skill of skills) {
		const { server } = resolveToolRef(skill.tool);
		const path = SKILL_PATH_BY_SERVER[server];
		if (!path) continue;
		if (servers.has(server)) continue;
		servers.set(server, {
			name: server,
			description:
				SKILL_DESCRIPTION_BY_SERVER[server] ??
				`Skill instructions for ${server} tools.`,
			path,
		});
	}
	if (servers.size === 0) return "";
	const entries = Array.from(servers.values())
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) =>
			[
				"  <skill>",
				`    <name>${entry.name}</name>`,
				`    <description>${entry.description}</description>`,
				`    <location>${entry.path}</location>`,
				"  </skill>",
			].join("\n"),
		)
		.join("\n");
	return ["<available_skills>", entries, "</available_skills>"].join("\n");
}
