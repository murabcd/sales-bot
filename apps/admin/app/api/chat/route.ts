import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
	const { messages }: { messages: UIMessage[] } = await req.json();

	const result = streamText({
		model: openai("gpt-4o-mini"),
		system: `You are a helpful assistant for the Omni admin dashboard. You help users with:
- Understanding system status and metrics
- Running manual operations
- Troubleshooting issues
- Explaining configuration options

Be concise and helpful. Format responses with markdown when appropriate.`,
		messages: await convertToModelMessages(messages),
	});

	return result.toUIMessageStreamResponse();
}
