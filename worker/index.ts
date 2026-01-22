import modelsConfig from "../config/models.json";
import { createBot } from "../src/bot.js";

const startTime = Date.now();

let botPromise: Promise<Awaited<ReturnType<typeof createBot>>["bot"]> | null =
	null;

function getUptimeSeconds() {
	return (Date.now() - startTime) / 1000;
}

async function getBot(env: Record<string, string | undefined>) {
	if (!botPromise) {
		botPromise = (async () => {
			const { bot } = await createBot({
				env,
				modelsConfig,
				runtimeSkills: [],
				getUptimeSeconds,
			});
			await bot.init();
			return bot;
		})();
	}
	return botPromise;
}

export default {
	async fetch(
		request: Request,
		env: Record<string, string | undefined>,
		ctx: ExecutionContext,
	) {
		const url = new URL(request.url);
		if (url.pathname !== "/telegram") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const update = await request.json();
		const bot = await getBot(env);
		ctx.waitUntil(
			bot.handleUpdate(update).catch((error) => {
				console.error("telegram_update_error", error);
			}),
		);
		return new Response("OK", { status: 200 });
	},
};
