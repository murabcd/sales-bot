import type { ToolExecutionOptions, ToolSet } from "ai";

export type ToolHookContext = {
	toolName: string;
	toolCallId?: string;
	input: unknown;
	chatId?: string;
	userId?: string;
};

export type ToolHooks = {
	beforeToolCall?: (
		ctx: ToolHookContext,
	) => { allow?: boolean; reason?: string } | undefined;
	afterToolCall?: (
		ctx: ToolHookContext & { durationMs: number; error?: string },
	) => void;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		typeof value === "object" && value !== null && Symbol.asyncIterator in value
	);
}

export function wrapToolMapWithHooks(
	tools: ToolSet,
	hooks: ToolHooks,
): ToolSet {
	const wrapped: ToolSet = {};
	for (const [name, toolDef] of Object.entries(tools)) {
		if (!toolDef?.execute) {
			wrapped[name] = toolDef;
			continue;
		}
		const execute = toolDef.execute;
		wrapped[name] = {
			...toolDef,
			execute: async (input: unknown, options: ToolExecutionOptions) => {
				const context: ToolHookContext = {
					toolName: name,
					toolCallId: options?.toolCallId,
					input,
				};
				const guard = hooks.beforeToolCall?.(context);
				if (guard && guard.allow === false) {
					throw new Error(
						guard.reason
							? `TOOL_CALL_BLOCKED: ${guard.reason}`
							: "TOOL_CALL_BLOCKED",
					);
				}
				const startedAt = Date.now();
				try {
					const result = await execute(input as never, options);
					if (isAsyncIterable(result)) {
						const iterator = result;
						const wrappedIterator = (async function* () {
							try {
								for await (const chunk of iterator) {
									yield chunk;
								}
							} catch (error) {
								hooks.afterToolCall?.({
									...context,
									durationMs: Date.now() - startedAt,
									error: String(error),
								});
								throw error;
							}
							hooks.afterToolCall?.({
								...context,
								durationMs: Date.now() - startedAt,
							});
						})();
						return wrappedIterator as never;
					}
					hooks.afterToolCall?.({
						...context,
						durationMs: Date.now() - startedAt,
					});
					return result;
				} catch (error) {
					hooks.afterToolCall?.({
						...context,
						durationMs: Date.now() - startedAt,
						error: String(error),
					});
					throw error;
				}
			},
		};
	}
	return wrapped;
}
