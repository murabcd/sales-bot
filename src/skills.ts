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

	const pendingDirs: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			pendingDirs.push(path.join(skillsDir, entry.name));
		}
	}

	const skillFiles: string[] = [];
	while (pendingDirs.length) {
		const dir = pendingDirs.pop();
		if (!dir) continue;
		let dirEntries: Array<Dirent> = [];
		try {
			dirEntries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			console.warn(`[skills] Failed to read ${dir}:`, error);
			continue;
		}
		for (const entry of dirEntries) {
			if (entry.isDirectory()) {
				pendingDirs.push(path.join(dir, entry.name));
				continue;
			}
			if (entry.isFile() && entry.name === "skill.json") {
				skillFiles.push(path.join(dir, entry.name));
			}
		}
	}

	const skills: RuntimeSkill[] = [];
	for (const skillPath of skillFiles) {
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
