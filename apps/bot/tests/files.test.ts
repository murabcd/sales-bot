import { describe, expect, it } from "vitest";
import { isDocxDocument, isPdfDocument } from "../src/lib/files.js";

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

describe("isDocxDocument", () => {
	it("returns true for DOCX mime type", () => {
		expect(
			isDocxDocument({
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			}),
		).toBe(true);
	});

	it("returns true for .docx extension", () => {
		expect(isDocxDocument({ fileName: "proposal.DOCX" })).toBe(true);
	});

	it("returns false for non-DOCX", () => {
		expect(
			isDocxDocument({
				mimeType: "application/octet-stream",
				fileName: "notes.txt",
			}),
		).toBe(false);
	});
});
