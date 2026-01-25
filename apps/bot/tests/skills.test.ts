import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/skills.js";

async function writeSkill(dir: string, name: string, tool: string) {
	const skillDir = path.join(dir, name.replace(/\s+/g, "-").toLowerCase());
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(
		path.join(skillDir, "skill.json"),
		JSON.stringify({ name, tool }, null, 2),
		"utf8",
	);
}

describe("loadSkills", () => {
	it("skips duplicate skill names", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omni-skills-"));
		await writeSkill(tmp, "Duplicate", "yandex-tracker.issue_get");
		await writeSkill(tmp, "Duplicate", "yandex-tracker.issue_get_comments");
		const skills = await loadSkills(tmp);
		expect(skills).toHaveLength(1);
	});

	it("skips duplicate tool references", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omni-skills-"));
		await writeSkill(tmp, "First", "yandex-tracker.issue_get");
		await writeSkill(tmp, "Second", "yandex-tracker.issue_get");
		const skills = await loadSkills(tmp);
		expect(skills).toHaveLength(1);
	});
});
