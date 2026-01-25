import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills } from "../src/skills.js";

const outputPath = path.resolve("config/runtime-skills.json");
const skills = await loadSkills("skills");

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(
	outputPath,
	`${JSON.stringify(skills, null, "\t")}\n`,
	"utf8",
);
console.log(`[skills] wrote ${skills.length} runtime skills to ${outputPath}`);
