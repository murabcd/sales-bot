import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type RuntimeSkill = {
	name: string;
	description?: string;
	tool: string;
	args?: Record<string, unknown>;
	timeoutMs?: number;
};

type RawSkill = Partial<RuntimeSkill>;

export type ToolRef = {
	server: string;
	tool: string;
};

export function resolveToolRef(
	toolRef: string,
	defaultServer = "yandex-tracker",
): ToolRef {
	const trimmed = toolRef.trim();
	if (!trimmed) {
		return { server: defaultServer, tool: "" };
	}
	const dotIndex = trimmed.indexOf(".");
	if (dotIndex === -1) {
		return { server: defaultServer, tool: trimmed };
	}
	const server = trimmed.slice(0, dotIndex);
	const tool = trimmed.slice(dotIndex + 1);
	return { server, tool };
}

export async function loadSkills(baseDir = "skills"): Promise<RuntimeSkill[]> {
	const skillsDir = path.resolve(baseDir);
	let entries: Array<Dirent> = [];
	try {
		entries = await fs.readdir(skillsDir, { withFileTypes: true });
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}

	const skills: RuntimeSkill[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillPath = path.join(skillsDir, entry.name, "skill.json");
		let raw: RawSkill;
		try {
			const file = await fs.readFile(skillPath, "utf8");
			raw = JSON.parse(file) as RawSkill;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				continue;
			}
			console.warn(`[skills] Failed to load ${skillPath}:`, error);
			continue;
		}

		if (!raw?.name || !raw.tool) {
			console.warn(
				`[skills] Invalid skill.json (missing name/tool): ${skillPath}`,
			);
			continue;
		}

		skills.push({
			name: raw.name,
			description: raw.description,
			tool: raw.tool,
			args: raw.args ?? undefined,
			timeoutMs: raw.timeoutMs,
		});
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
