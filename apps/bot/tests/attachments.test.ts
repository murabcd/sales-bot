import { describe, expect, it } from "vitest";
import {
	buildAttachmentPrompt,
	extractGoogleLinks,
	isSupportedAttachment,
	normalizeTrackerAttachment,
	parseConsent,
} from "../src/lib/attachments.js";
import type { PendingAttachmentRequest } from "../src/lib/context/chat-state.js";

describe("parseConsent", () => {
	it("recognizes positive confirmations", () => {
		expect(parseConsent("да")).toBe("yes");
		expect(parseConsent("Да, пожалуйста")).toBe("yes");
		expect(parseConsent("okay")).toBe("yes");
	});

	it("recognizes negative confirmations", () => {
		expect(parseConsent("нет")).toBe("no");
		expect(parseConsent("не надо, спасибо")).toBe("no");
		expect(parseConsent("no")).toBe("no");
	});

	it("returns null for unrelated input", () => {
		expect(parseConsent("maybe")).toBeNull();
		expect(parseConsent("")).toBeNull();
	});
});

describe("extractGoogleLinks", () => {
	it("extracts and deduplicates Google Docs/Sheets links", () => {
		const text =
			"See https://docs.google.com/document/d/abc123/edit and " +
			"https://docs.google.com/spreadsheets/d/xyz789/edit?gid=0 " +
			"and again https://docs.google.com/document/d/abc123/edit.";
		const links = extractGoogleLinks(text).sort();
		expect(links).toEqual([
			"https://docs.google.com/document/d/abc123/edit",
			"https://docs.google.com/spreadsheets/d/xyz789/edit?gid=0",
		]);
	});
});

describe("normalizeTrackerAttachment", () => {
	it("normalizes id and filename variations", () => {
		const normalized = normalizeTrackerAttachment({
			attachmentId: "a1",
			fileName: "contract.pdf",
			contentType: "application/pdf",
			fileSize: 123,
		});
		expect(normalized).toEqual({
			id: "a1",
			filename: "contract.pdf",
			mimeType: "application/pdf",
			size: 123,
		});
	});

	it("returns null when id is missing", () => {
		expect(normalizeTrackerAttachment({ filename: "x.pdf" })).toBeNull();
	});
});

describe("isSupportedAttachment", () => {
	it("accepts PDF/DOCX candidates", () => {
		expect(
			isSupportedAttachment({
				id: "1",
				filename: "file.pdf",
				mimeType: "application/pdf",
			}),
		).toBe(true);
		expect(
			isSupportedAttachment({
				id: "2",
				filename: "file.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			}),
		).toBe(true);
	});

	it("rejects other formats", () => {
		expect(
			isSupportedAttachment({
				id: "3",
				filename: "file.txt",
				mimeType: "text/plain",
			}),
		).toBe(false);
	});
});

describe("buildAttachmentPrompt", () => {
	it("includes file and link sections", () => {
		const request: PendingAttachmentRequest = {
			issueKey: "PROJ-1",
			question: "Что с тикетом?",
			createdAt: Date.now(),
			attachments: [
				{ id: "1", filename: "spec.pdf", mimeType: "application/pdf" },
			],
			googleLinks: ["https://docs.google.com/document/d/abc123/edit"],
		};
		const prompt = buildAttachmentPrompt(request);
		expect(prompt).toContain("Вложения (PDF/DOCX):");
		expect(prompt).toContain("spec.pdf");
		expect(prompt).toContain("Google Docs/Sheets ссылки:");
		expect(prompt).toContain("docs.google.com/document/d/abc123");
		expect(prompt).toContain("Прочитать и учесть их в ответе? (да/нет)");
	});
});
