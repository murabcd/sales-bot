import type { RuntimeSkill } from "../skills-core.js";

export type ChannelConfig = {
	id: string;
	label?: string;
	enabled: boolean;
	requireMention?: boolean;
	allowUserIds?: string[];
	skillsAllowlist?: string[];
	skillsDenylist?: string[];
	systemPrompt?: string;
};

export function parseChannelConfig(raw: unknown): ChannelConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	return raw as ChannelConfig;
}

export function shouldRequireMentionForChannel(params: {
	channelConfig?: ChannelConfig;
	defaultRequireMention: boolean;
}) {
	const override = params.channelConfig?.requireMention;
	return typeof override === "boolean"
		? override
		: params.defaultRequireMention;
}

export function isUserAllowedForChannel(params: {
	userId: string;
	globalAllowlist: Set<string>;
	channelAllowlist: string[];
}) {
	const allowedByChannel =
		params.channelAllowlist.length > 0
			? params.channelAllowlist.includes(params.userId)
			: false;
	const allowedByGlobal = params.globalAllowlist.has(params.userId);
	return allowedByChannel || allowedByGlobal;
}

export function filterSkillsForChannel(params: {
	skills: RuntimeSkill[];
	channelConfig?: ChannelConfig;
}) {
	const allowlist = params.channelConfig?.skillsAllowlist;
	const denylist = params.channelConfig?.skillsDenylist;
	let next = params.skills;
	if (Array.isArray(allowlist)) {
		if (allowlist.length === 0) return [];
		const allowed = new Set(allowlist);
		next = next.filter((skill) => allowed.has(skill.name));
	}
	if (Array.isArray(denylist) && denylist.length > 0) {
		const denied = new Set(denylist);
		next = next.filter((skill) => !denied.has(skill.name));
	}
	return next;
}
