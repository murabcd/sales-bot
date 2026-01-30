import { describe, expect, it, vi } from "vitest";
import { createFigmaClient } from "../src/lib/clients/figma.js";

describe("createFigmaClient", () => {
	it("retries AbortError and succeeds", async () => {
		vi.useFakeTimers();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("AbortError: The operation was aborted"))
			.mockRejectedValueOnce(new Error("AbortError: The operation was aborted"))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "{}",
			});
		(globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
			fetchMock as typeof fetch;
		const client = createFigmaClient({
			token: "test-token",
			apiBaseUrl: "https://api.figma.com",
			logDebug: () => {},
		});

		try {
			const promise = client.figmaMe({ timeoutMs: 10 });
			if (typeof vi.runAllTimersAsync === "function") {
				await vi.runAllTimersAsync();
			} else {
				vi.runAllTimers();
				await Promise.resolve();
			}
			await promise;

			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			if (originalFetch) {
				(globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
					originalFetch;
			} else {
				Reflect.deleteProperty(
					globalThis as Record<string, unknown>,
					"fetch",
				);
			}
			vi.useRealTimers();
		}
	});
});
