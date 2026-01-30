export type FigmaClientConfig = {
	token: string;
	apiBaseUrl: string;
	logDebug: (event: string, payload?: Record<string, unknown>) => void;
};

export type FigmaClient = {
	figmaMe: (options?: {
		timeoutMs?: number;
	}) => Promise<Record<string, unknown>>;
	figmaFileGet: (options: {
		fileKey: string;
		version?: string;
		ids?: string[];
		depth?: number;
		geometry?: "paths" | "bounds";
		pluginData?: string;
		branchData?: boolean;
		timeoutMs?: number;
	}) => Promise<Record<string, unknown>>;
	figmaFileNodesGet: (options: {
		fileKey: string;
		ids: string[];
		version?: string;
		depth?: number;
		geometry?: "paths" | "bounds";
		pluginData?: string;
		branchData?: boolean;
		timeoutMs?: number;
	}) => Promise<Record<string, unknown>>;
	figmaFileCommentsList: (options: {
		fileKey: string;
		limit?: number;
		after?: string;
		timeoutMs?: number;
	}) => Promise<Record<string, unknown>>;
	figmaProjectFilesList: (options: {
		projectId: string;
		timeoutMs?: number;
	}) => Promise<Record<string, unknown>>;
};

export function createFigmaClient(config: FigmaClientConfig): FigmaClient {
	function figmaHeaders(): Record<string, string> {
		return {
			Accept: "application/json",
			"X-Figma-Token": config.token,
		};
	}

	function buildFigmaUrl(pathname: string, query?: Record<string, string>) {
		const base = new URL(config.apiBaseUrl);
		const basePath = base.pathname.endsWith("/")
			? base.pathname.slice(0, -1)
			: base.pathname;
		const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
		base.pathname = `${basePath}${path}`;
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== "") {
					base.searchParams.set(key, value);
				}
			}
		}
		return base.toString();
	}

	async function figmaRequest<T>(
		method: string,
		pathname: string,
		options: {
			query?: Record<string, string>;
			timeoutMs?: number;
		} = {},
	): Promise<T> {
		const timeoutMs = options.timeoutMs ?? 8_000;
		const maxAttempts = 3;
		let lastError: unknown = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const init: RequestInit = {
					method,
					headers: figmaHeaders(),
					signal: controller.signal,
				};
				const url = buildFigmaUrl(pathname, options.query);
				const response = await fetch(url, init);
				const text = await response.text();
				if (!response.ok) {
					throw new Error(
						`figma_error:${response.status}:${response.statusText}:${text}`,
					);
				}
				if (!text.trim()) return undefined as T;
				try {
					return JSON.parse(text) as T;
				} catch {
					return text as T;
				}
			} catch (error) {
				lastError = error;
				const message = String(error);
				const shouldRetry =
					message.includes("AbortError") || message.includes("timeout");
				if (!shouldRetry || attempt >= maxAttempts) {
					throw error;
				}
				const delayMs = 250 * 2 ** (attempt - 1);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			} finally {
				clearTimeout(timeout);
			}
		}
		throw lastError ?? new Error("figma_request_failed");
	}

	async function figmaMe(options?: { timeoutMs?: number }) {
		return figmaRequest<Record<string, unknown>>("GET", "/v1/me", {
			timeoutMs: options?.timeoutMs,
		});
	}

	async function figmaFileGet(options: {
		fileKey: string;
		version?: string;
		ids?: string[];
		depth?: number;
		geometry?: "paths" | "bounds";
		pluginData?: string;
		branchData?: boolean;
		timeoutMs?: number;
	}) {
		const query: Record<string, string> = {};
		if (options.version) query.version = options.version;
		if (options.ids?.length) query.ids = options.ids.join(",");
		if (typeof options.depth === "number") query.depth = String(options.depth);
		if (options.geometry) query.geometry = options.geometry;
		if (options.pluginData) query.plugin_data = options.pluginData;
		if (options.branchData !== undefined) {
			query.branch_data = options.branchData ? "true" : "false";
		}
		return figmaRequest<Record<string, unknown>>(
			"GET",
			`/v1/files/${options.fileKey}`,
			{ query, timeoutMs: options.timeoutMs },
		);
	}

	async function figmaFileNodesGet(options: {
		fileKey: string;
		ids: string[];
		version?: string;
		depth?: number;
		geometry?: "paths" | "bounds";
		pluginData?: string;
		branchData?: boolean;
		timeoutMs?: number;
	}) {
		const query: Record<string, string> = {
			ids: options.ids.join(","),
		};
		if (options.version) query.version = options.version;
		if (typeof options.depth === "number") query.depth = String(options.depth);
		if (options.geometry) query.geometry = options.geometry;
		if (options.pluginData) query.plugin_data = options.pluginData;
		if (options.branchData !== undefined) {
			query.branch_data = options.branchData ? "true" : "false";
		}
		return figmaRequest<Record<string, unknown>>(
			"GET",
			`/v1/files/${options.fileKey}/nodes`,
			{ query, timeoutMs: options.timeoutMs },
		);
	}

	async function figmaFileCommentsList(options: {
		fileKey: string;
		limit?: number;
		after?: string;
		timeoutMs?: number;
	}) {
		const query: Record<string, string> = {};
		if (typeof options.limit === "number") query.limit = String(options.limit);
		if (options.after) query.after = options.after;
		return figmaRequest<Record<string, unknown>>(
			"GET",
			`/v1/files/${options.fileKey}/comments`,
			{ query, timeoutMs: options.timeoutMs },
		);
	}

	async function figmaProjectFilesList(options: {
		projectId: string;
		timeoutMs?: number;
	}) {
		return figmaRequest<Record<string, unknown>>(
			"GET",
			`/v1/projects/${options.projectId}/files`,
			{ timeoutMs: options.timeoutMs },
		);
	}

	return {
		figmaMe,
		figmaFileGet,
		figmaFileNodesGet,
		figmaFileCommentsList,
		figmaProjectFilesList,
	};
}
