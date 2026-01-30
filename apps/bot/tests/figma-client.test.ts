import { describe, expect, it, vi } from "vitest";
import { createFigmaClient } from "../src/lib/clients/figma.js";

describe("createFigmaClient", () => {
	it("retries AbortError and succeeds", async () => {
		vi.useFakeTimers();
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
		vi.stubGlobal("fetch", fetchMock);
		const client = createFigmaClient({
			token: "test-token",
			apiBaseUrl: "https://api.figma.com",
			logDebug: () => {},
		});

		const promise = client.figmaMe({ timeoutMs: 10 });
		vi.runAllTimers();
		await promise;

		expect(fetchMock).toHaveBeenCalledTimes(3);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
});
