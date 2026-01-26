import { describe, expect, it } from "vitest";
import {
	filterSkillsForChannel,
	isUserAllowedForChannel,
	parseChannelConfig,
	shouldRequireMentionForChannel,
} from "../src/lib/channels.js";
import type { RuntimeSkill } from "../src/skills-core.js";

const skills: RuntimeSkill[] = [
	{ name: "alpha", tool: "alpha.tool" },
	{ name: "beta", tool: "beta.tool" },
	{ name: "gamma", tool: "gamma.tool" },
];

describe("channel config helpers", () => {
	it("parses channel config objects", () => {
		const parsed = parseChannelConfig({ requireMention: true });
		expect(parsed?.requireMention).toBe(true);
		expect(parseChannelConfig(null)).toBeUndefined();
		expect(parseChannelConfig("nope")).toBeUndefined();
	});

	it("respects require-mention overrides", () => {
		expect(
			shouldRequireMentionForChannel({
				channelConfig: { id: "c1", enabled: true, requireMention: true },
				defaultRequireMention: false,
			}),
		).toBe(true);
		expect(
			shouldRequireMentionForChannel({
				channelConfig: { id: "c1", enabled: true, requireMention: false },
				defaultRequireMention: true,
			}),
		).toBe(false);
		expect(
			shouldRequireMentionForChannel({
				channelConfig: { id: "c1", enabled: true },
				defaultRequireMention: true,
			}),
		).toBe(true);
	});

	it("filters skills by allowlist and denylist", () => {
		const allowedOnly = filterSkillsForChannel({
			skills,
			channelConfig: {
				id: "c1",
				enabled: true,
				skillsAllowlist: ["alpha", "beta"],
			},
		});
		expect(allowedOnly.map((s) => s.name)).toEqual(["alpha", "beta"]);

		const allowAndDeny = filterSkillsForChannel({
			skills,
			channelConfig: {
				id: "c1",
				enabled: true,
				skillsAllowlist: ["alpha", "beta"],
				skillsDenylist: ["beta"],
			},
		});
		expect(allowAndDeny.map((s) => s.name)).toEqual(["alpha"]);

		const denied = filterSkillsForChannel({
			skills,
			channelConfig: {
				id: "c1",
				enabled: true,
				skillsDenylist: ["gamma"],
			},
		});
		expect(denied.map((s) => s.name)).toEqual(["alpha", "beta"]);

		const emptyAllowlist = filterSkillsForChannel({
			skills,
			channelConfig: {
				id: "c1",
				enabled: true,
				skillsAllowlist: [],
			},
		});
		expect(emptyAllowlist).toEqual([]);
	});

	it("allows users via channel or global allowlists", () => {
		const globalAllowlist = new Set(["1"]);
		expect(
			isUserAllowedForChannel({
				userId: "1",
				globalAllowlist,
				channelAllowlist: [],
			}),
		).toBe(true);
		expect(
			isUserAllowedForChannel({
				userId: "2",
				globalAllowlist,
				channelAllowlist: ["2"],
			}),
		).toBe(true);
		expect(
			isUserAllowedForChannel({
				userId: "3",
				globalAllowlist,
				channelAllowlist: ["2"],
			}),
		).toBe(false);
	});
});
