import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeToolName } from "./lib/tools/registry.js";
import { type RuntimeSkill, resolveToolRef } from "./skills-core.js";

type RawSkill = Partial<RuntimeSkill>;

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
	const seenNames = new Set<string>();
	const seenToolRefs = new Set<string>();
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

		const normalizedName = normalizeToolName(raw.name);
		if (!normalizedName) {
			console.warn(
				`[skills] Invalid skill name (empty after normalization): ${skillPath}`,
			);
			continue;
		}
		if (seenNames.has(normalizedName)) {
			console.warn(
				`[skills] Duplicate skill name "${raw.name}" (normalized "${normalizedName}") skipped: ${skillPath}`,
			);
			continue;
		}

		const { server, tool } = resolveToolRef(raw.tool);
		const normalizedTool = normalizeToolName(tool);
		const toolRef = `${server.trim().toLowerCase()}:${normalizedTool}`;
		if (!normalizedTool) {
			console.warn(
				`[skills] Invalid tool reference (empty after normalization): ${skillPath}`,
			);
			continue;
		}
		if (seenToolRefs.has(toolRef)) {
			console.warn(
				`[skills] Duplicate tool reference "${toolRef}" skipped: ${skillPath}`,
			);
			continue;
		}

		seenNames.add(normalizedName);
		seenToolRefs.add(toolRef);

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

export { resolveToolRef, type RuntimeSkill };
