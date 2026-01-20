import fs from "node:fs";
import path from "node:path";

export type HistoryMessage = {
	timestamp: string;
	role: "user" | "assistant";
	text: string;
};

export function resolveSessionDir(baseDir: string): string {
	return path.isAbsolute(baseDir) ? baseDir : path.join(process.cwd(), baseDir);
}

export function resolveSessionFile(baseDir: string, chatId: string): string {
	return path.join(resolveSessionDir(baseDir), `${chatId}.jsonl`);
}

export function appendHistoryMessage(
	baseDir: string,
	chatId: string,
	message: HistoryMessage,
): void {
	const dir = resolveSessionDir(baseDir);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = resolveSessionFile(baseDir, chatId);
	fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, "utf8");
}

export function loadHistoryMessages(
	baseDir: string,
	chatId: string,
	limit: number,
): HistoryMessage[] {
	const filePath = resolveSessionFile(baseDir, chatId);
	if (!fs.existsSync(filePath)) return [];
	const raw = fs.readFileSync(filePath, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	const slice = limit > 0 ? lines.slice(-limit) : lines;
	const messages: HistoryMessage[] = [];
	for (const line of slice) {
		try {
			const parsed = JSON.parse(line) as HistoryMessage;
			if (parsed?.role && parsed?.text) messages.push(parsed);
		} catch {
			// ignore malformed lines
		}
	}
	return messages;
}

export function clearHistoryMessages(baseDir: string, chatId: string): void {
	const filePath = resolveSessionFile(baseDir, chatId);
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

export function formatHistoryForPrompt(messages: HistoryMessage[]): string {
	if (!messages.length) return "";
	const lines = messages.map((msg) => {
		const role = msg.role === "user" ? "User" : "Assistant";
		return `${role}: ${msg.text}`;
	});
	return ["Conversation history:", ...lines, ""].join("\n");
}
