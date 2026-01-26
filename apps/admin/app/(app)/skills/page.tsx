"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGateway } from "@/components/gateway-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SkillStatusEntry, SkillStatusReport } from "@/lib/skills-types";

type SkillMessage = {
	kind: "success" | "error";
	message: string;
};

type SkillMessageMap = Record<string, SkillMessage>;

function clamp(text: string, max = 140) {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}...`;
}

export default function SkillsPage() {
	const { skillsStatus, skillsUpdate, skillsInstall } = useGateway();
	const [, setLoading] = useState(false);
	const [report, setReport] = useState<SkillStatusReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [messages, setMessages] = useState<SkillMessageMap>({});
	const loadingRef = useRef(false);

	const skills = report?.skills ?? [];
	const filtered = useMemo(() => {
		const trimmed = filter.trim().toLowerCase();
		if (!trimmed) return skills;
		return skills.filter((skill) =>
			[skill.name, skill.description, skill.source]
				.join(" ")
				.toLowerCase()
				.includes(trimmed),
		);
	}, [filter, skills]);

	const grouped = useMemo(() => {
		const groups = new Map<string, SkillStatusEntry[]>();
		for (const skill of filtered) {
			const key = skill.server || "unknown";
			const entry = groups.get(key);
			if (entry) entry.push(skill);
			else groups.set(key, [skill]);
		}
		return Array.from(groups.entries());
	}, [filtered]);

	const setSkillMessage = (skillKey: string, message?: SkillMessage) => {
		setMessages((prev) => {
			const next = { ...prev };
			if (message) next[skillKey] = message;
			else delete next[skillKey];
			return next;
		});
	};

	const loadSkills = useCallback(
		async (clearMessages = false) => {
			if (loadingRef.current) return;
			loadingRef.current = true;
			setLoading(true);
			setError(null);
			if (clearMessages) setMessages({});
			try {
				const res = await skillsStatus();
				setReport(res);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				loadingRef.current = false;
				setLoading(false);
			}
		},
		[skillsStatus],
	);

	useEffect(() => {
		void loadSkills();
	}, [loadSkills]);

	const updateSkillEnabled = async (skill: SkillStatusEntry) => {
		setBusyKey(skill.skillKey);
		setError(null);
		try {
			await skillsUpdate({
				skillKey: skill.skillKey,
				enabled: skill.disabled,
			});
			await loadSkills();
			setSkillMessage(skill.skillKey, {
				kind: "success",
				message: skill.disabled ? "Skill enabled" : "Skill disabled",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setSkillMessage(skill.skillKey, { kind: "error", message });
		} finally {
			setBusyKey(null);
		}
	};

	const installSkill = async (skill: SkillStatusEntry, installId: string) => {
		setBusyKey(skill.skillKey);
		setError(null);
		try {
			const result = await skillsInstall({
				name: skill.name,
				installId,
				timeoutMs: 120_000,
			});
			await loadSkills();
			setSkillMessage(skill.skillKey, {
				kind: "success",
				message: result?.message ?? "Installed",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setSkillMessage(skill.skillKey, { kind: "error", message });
		} finally {
			setBusyKey(null);
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-3 md:flex-row md:items-center">
				<div className="flex-1 max-w-[420px]">
					<Input
						placeholder="Search skills"
						className="bg-transparent"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
				</div>
				<div className="text-xs text-muted-foreground">
					{filtered.length} shown
				</div>
			</div>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle className="size-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{filtered.length === 0 ? (
				<p className="text-sm text-muted-foreground">No skills found.</p>
			) : (
				<div className="space-y-6">
					{grouped.map(([server, items]) => (
						<div key={server} className="space-y-3">
							<div className="text-xs uppercase tracking-wide text-muted-foreground">
								{server}
							</div>
							{items.map((skill) => {
								const missing = [
									...skill.missing.bins.map((value) => `bin:${value}`),
									...skill.missing.env.map((value) => `env:${value}`),
									...skill.missing.config.map((value) => `config:${value}`),
									...skill.missing.os.map((value) => `os:${value}`),
								];
								const reasons: string[] = [];
								if (skill.disabled) reasons.push("disabled");
								if (skill.blockedByAllowlist) {
									reasons.push("blocked by allowlist");
								}
								const message = messages[skill.skillKey];
								const canInstall =
									skill.install.length > 0 && skill.missing.bins.length > 0;
								return (
									<Card key={skill.skillKey}>
										<CardHeader>
											<div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
												<div className="space-y-2">
													<CardTitle className="text-base">
														{skill.emoji ? `${skill.emoji} ` : ""}
														{skill.name}
													</CardTitle>
													<CardDescription>
														{clamp(skill.description || "", 160)}
													</CardDescription>
													<div className="flex flex-wrap gap-2">
														<Badge variant="muted">{skill.source}</Badge>
														<Badge
															variant={skill.eligible ? "success" : "warning"}
														>
															{skill.eligible ? "eligible" : "blocked"}
														</Badge>
														{skill.disabled ? (
															<Badge variant="warning">disabled</Badge>
														) : null}
													</div>
													{missing.length > 0 ? (
														<p className="text-xs text-muted-foreground">
															Missing: {missing.join(", ")}
														</p>
													) : null}
													{reasons.length > 0 ? (
														<p className="text-xs text-muted-foreground">
															Reason: {reasons.join(", ")}
														</p>
													) : null}
													{message ? (
														<p
															className={
																message.kind === "error"
																	? "text-xs text-rose-400"
																	: "text-xs text-emerald-400"
															}
														>
															{message.message}
														</p>
													) : null}
												</div>
												<div className="flex flex-wrap gap-2 md:justify-end">
													<Button
														size="sm"
														variant="outline"
														onClick={() => updateSkillEnabled(skill)}
														disabled={busyKey === skill.skillKey}
													>
														{busyKey === skill.skillKey ? (
															<Loader2 className="size-3 animate-spin" />
														) : null}
														{skill.disabled ? "Enable" : "Disable"}
													</Button>
													{canInstall ? (
														<Button
															size="sm"
															variant="outline"
															onClick={() =>
																installSkill(skill, skill.install[0].id)
															}
															disabled={busyKey === skill.skillKey}
														>
															{busyKey === skill.skillKey ? (
																<Loader2 className="size-3 animate-spin" />
															) : null}
															{skill.install[0].label}
														</Button>
													) : null}
												</div>
											</div>
										</CardHeader>
										<CardContent>
											{skill.missing.env.length > 0 ? (
												<p className="text-xs text-muted-foreground">
													Set global env values to satisfy requirements.
												</p>
											) : null}
										</CardContent>
									</Card>
								);
							})}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
