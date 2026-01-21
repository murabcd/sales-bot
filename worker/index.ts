import { webhookCallback } from "grammy";
import modelsConfig from "../config/models.json";
import { createBot } from "../src/bot.js";

const startTime = Date.now();

let handlerPromise: Promise<(request: Request) => Promise<Response>> | null =
	null;

function getUptimeSeconds() {
	return (Date.now() - startTime) / 1000;
}

async function getHandler(env: Record<string, string | undefined>) {
	if (!handlerPromise) {
		handlerPromise = (async () => {
			const { bot } = await createBot({
				env,
				modelsConfig,
				runtimeSkills: [],
				getUptimeSeconds,
			});
			return webhookCallback(bot, "cloudflare-mod");
		})();
	}
	return handlerPromise;
}

export default {
	async fetch(request: Request, env: Record<string, string | undefined>) {
		const url = new URL(request.url);
		if (url.pathname !== "/telegram") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const handler = await getHandler(env);
		return handler(request);
	},
};
