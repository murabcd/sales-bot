import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createBot } from "./bot.js";
import { loadModelsConfig } from "./models.js";
import { loadSkills } from "./skills.js";

dotenv.config();

const modelsConfig = await loadModelsConfig();
const runtimeSkills = await loadSkills();

const DEBUG_LOG_FILE = process.env.DEBUG_LOG_FILE ?? "";

function createDebugAppender(filePath: string) {
	if (!filePath) return undefined;
	return (line: string) => {
		try {
			const fullPath = path.isAbsolute(filePath)
				? filePath
				: path.join(process.cwd(), filePath);
			fs.appendFileSync(fullPath, `${line}\n`);
		} catch {
			// ignore log file errors to avoid breaking runtime
		}
	};
}

const onDebugLog = createDebugAppender(DEBUG_LOG_FILE);

const { bot, allowedUpdates } = await createBot({
	env: process.env,
	modelsConfig,
	runtimeSkills,
	getUptimeSeconds: () => process.uptime(),
	onDebugLog,
});

process.once("SIGINT", () => {
	bot.stop();
});
process.once("SIGTERM", () => {
	bot.stop();
});

bot.start({ allowed_updates: allowedUpdates });
