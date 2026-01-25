import { describe, expect, it } from "vitest";
import { authorizeAdminRequest } from "../src/lib/gateway/admin-auth.js";

describe("gateway admin auth", () => {
	it("denies when token missing", () => {
		const req = new Request("https://example.com/admin/status");
		const decision = authorizeAdminRequest(req, {});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("admin_token_missing");
	});

	it("denies when token invalid", () => {
		const req = new Request("https://example.com/admin/status", {
			headers: { Authorization: "Bearer nope" },
		});
		const decision = authorizeAdminRequest(req, { ADMIN_API_TOKEN: "secret" });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("admin_token_invalid");
	});

	it("allows with valid token", () => {
		const req = new Request("https://example.com/admin/status", {
			headers: { Authorization: "Bearer secret" },
		});
		const decision = authorizeAdminRequest(req, { ADMIN_API_TOKEN: "secret" });
		expect(decision.allowed).toBe(true);
	});

	it("denies when ip not in allowlist", () => {
		const req = new Request("https://example.com/admin/status", {
			headers: {
				Authorization: "Bearer secret",
				"cf-connecting-ip": "1.1.1.1",
			},
		});
		const decision = authorizeAdminRequest(req, {
			ADMIN_API_TOKEN: "secret",
			ADMIN_ALLOWLIST: "2.2.2.2",
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("admin_ip_denied");
	});

	it("allows when ip in allowlist", () => {
		const req = new Request("https://example.com/admin/status", {
			headers: {
				Authorization: "Bearer secret",
				"cf-connecting-ip": "2.2.2.2",
			},
		});
		const decision = authorizeAdminRequest(req, {
			ADMIN_API_TOKEN: "secret",
			ADMIN_ALLOWLIST: "2.2.2.2,3.3.3.3",
		});
		expect(decision.allowed).toBe(true);
	});
});
