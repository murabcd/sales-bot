export type LogLevel = "info" | "error";

export type Logger = {
	info: (event: Record<string, unknown>) => void;
	error: (event: Record<string, unknown>) => void;
};

function stripUndefined<T extends Record<string, unknown>>(obj: T) {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) cleaned[key] = value;
	}
	return cleaned;
}

export function createLogger(base: Record<string, unknown>): Logger {
	const baseFields = stripUndefined(base);
	const log = (level: LogLevel, event: Record<string, unknown>) => {
		const payload = {
			timestamp: new Date().toISOString(),
			level,
			...baseFields,
			...stripUndefined(event),
		};
		const line = JSON.stringify(payload);
		if (level === "error") {
			console.error(line);
			return;
		}
		console.log(line);
	};

	return {
		info: (event) => log("info", event),
		error: (event) => log("error", event),
	};
}
