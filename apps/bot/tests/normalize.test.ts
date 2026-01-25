import { describe, expect, it } from "vitest";
import { extractIssueKeysFromText } from "../src/lib/text/normalize.js";

const PREFIX = "PROJ";

describe("extractIssueKeysFromText", () => {
	it("extracts explicit keys", () => {
		expect(extractIssueKeysFromText("PROJ-2961", PREFIX)).toEqual([
			"PROJ-2961",
		]);
	});

	it("extracts numeric keys", () => {
		expect(extractIssueKeysFromText("2961", PREFIX)).toEqual(["PROJ-2961"]);
	});

	it("extracts multiple keys", () => {
		expect(extractIssueKeysFromText("по проектам 2657 и 3576", PREFIX)).toEqual(
			["PROJ-2657", "PROJ-3576"],
		);
	});
});
