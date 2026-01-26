export type CronSchedule =
	| { kind: "at"; atMs: number }
	| { kind: "every"; everyMs: number; anchorMs?: number }
	| { kind: "cron"; expr: string; tz?: string };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
	| { kind: "systemEvent"; text: string }
	| { kind: "dailyStatus"; to?: string }
	| {
			kind: "agentTurn";
			message: string;
			model?: string;
			thinking?: string;
			timeoutSeconds?: number;
			deliver?: boolean;
			channel?:
				| "last"
				| "whatsapp"
				| "telegram"
				| "discord"
				| "slack"
				| "signal"
				| "imessage"
				| "msteams";
			provider?:
				| "last"
				| "whatsapp"
				| "telegram"
				| "discord"
				| "slack"
				| "signal"
				| "imessage"
				| "msteams";
			to?: string;
			bestEffortDeliver?: boolean;
	  };

export type CronIsolation = {
	postToMainPrefix?: string;
	postToMainMode?: "summary" | "full";
	postToMainMaxChars?: number;
};

export type CronJobState = {
	nextRunAtMs?: number;
	runningAtMs?: number;
	lastRunAtMs?: number;
	lastStatus?: "ok" | "error" | "skipped";
	lastError?: string;
	lastDurationMs?: number;
};

export type CronJob = {
	id: string;
	agentId?: string;
	name: string;
	description?: string;
	enabled: boolean;
	deleteAfterRun?: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	schedule: CronSchedule;
	sessionTarget: CronSessionTarget;
	wakeMode: CronWakeMode;
	payload: CronPayload;
	isolation?: CronIsolation;
	state?: CronJobState;
};

export type CronStatus = {
	enabled: boolean;
	jobs: number;
	nextWakeAtMs?: number | null;
};

export type CronRunLogEntry = {
	ts: number;
	jobId: string;
	status: "ok" | "error" | "skipped";
	durationMs?: number;
	error?: string;
	summary?: string;
};
