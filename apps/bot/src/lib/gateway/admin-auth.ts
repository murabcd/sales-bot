type AdminAuthDecision = { allowed: boolean; reason?: string };

function parseList(raw: string | undefined) {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function extractToken(request: Request) {
	const header = request.headers.get("authorization") ?? "";
	if (header.toLowerCase().startsWith("bearer ")) {
		return header.slice(7).trim();
	}
	return request.headers.get("x-admin-token") ?? "";
}

function extractClientIp(request: Request) {
	return (
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		""
	);
}

export function authorizeAdminRequest(
	request: Request,
	env: Record<string, string | undefined>,
): AdminAuthDecision {
	const token = env.ADMIN_API_TOKEN?.trim() ?? "";
	if (!token) {
		return { allowed: false, reason: "admin_token_missing" };
	}
	const provided = extractToken(request);
	if (!provided || provided !== token) {
		return { allowed: false, reason: "admin_token_invalid" };
	}
	const allowlist = parseList(env.ADMIN_ALLOWLIST);
	if (allowlist.length === 0) return { allowed: true };
	const ip = extractClientIp(request);
	if (!ip || !allowlist.includes(ip)) {
		return { allowed: false, reason: "admin_ip_denied" };
	}
	return { allowed: true };
}
