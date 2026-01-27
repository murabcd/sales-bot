import { describe, expect, it } from "vitest";
import { isPdfDocument } from "../src/lib/files.js";

describe("isPdfDocument", () => {
	it("returns true for PDF mime type", () => {
		expect(isPdfDocument({ mimeType: "application/pdf" })).toBe(true);
	});

	it("returns true for .pdf extension", () => {
		expect(isPdfDocument({ fileName: "report.PDF" })).toBe(true);
	});

	it("returns false for non-PDF", () => {
		expect(
			isPdfDocument({
				mimeType: "application/octet-stream",
				fileName: "a.bin",
			}),
		).toBe(false);
	});
});
