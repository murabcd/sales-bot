import fs from "node:fs/promises";
import path from "node:path";
import { buildBuiltinRuntimeSkills } from "../src/lib/runtime-skills-catalog.js";
import { normalizeToolName } from "../src/lib/tools/registry.js";
import { loadSkills } from "../src/skills.js";
import { type RuntimeSkill, resolveToolRef } from "../src/skills-core.js";

const outputPath = path.resolve("config/runtime-skills.json");
const fileSkills = await loadSkills("skills");
const builtinSkills = buildBuiltinRuntimeSkills();

const seenNames = new Set<string>();
const seenToolRefs = new Set<string>();
const skills: RuntimeSkill[] = [];

for (const skill of [...fileSkills, ...builtinSkills]) {
	const normalizedName = normalizeToolName(skill.name);
	if (!normalizedName || seenNames.has(normalizedName)) {
		continue;
	}
	const { server, tool } = resolveToolRef(skill.tool);
	const normalizedTool = normalizeToolName(tool);
	if (!normalizedTool) continue;
	const toolRef = `${server.trim().toLowerCase()}:${normalizedTool}`;
	if (seenToolRefs.has(toolRef)) continue;

	seenNames.add(normalizedName);
	seenToolRefs.add(toolRef);
	skills.push(skill);
}

skills.sort((a, b) => a.name.localeCompare(b.name));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(
	outputPath,
	`${JSON.stringify(skills, null, "\t")}\n`,
	"utf8",
);
console.log(`[skills] wrote ${skills.length} runtime skills to ${outputPath}`);
