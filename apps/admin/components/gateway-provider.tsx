"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	GatewayClient,
	type GatewayConfig,
	type GatewayConnectPayload,
} from "@/lib/gateway-client";

export type AdminStatus = {
	serviceName?: string;
	version?: string;
	commit?: string;
	region?: string;
	instanceId?: string;
	uptimeSeconds?: number;
	sessions?: { gatewayConnections?: number; activeStreams?: number };
	admin?: { authRequired?: boolean; allowlist?: string[] };
	cron?: {
		enabled?: boolean;
		chatId?: string;
		timezone?: string;
		sprintFilter?: string;
	};
	summary?: { enabled?: boolean; model?: string };
};

type AdminSettings = {
	baseUrl: string;
	token: string;
};

type GatewayContextValue = {
	baseUrl: string;
	token: string;
	status: AdminStatus | null;
	config: GatewayConfig;
	loading: boolean;
	error: string | null;
	configSaving: boolean;
	configError: string | null;
	setBaseUrl: (value: string) => void;
	setToken: (value: string) => void;
	connect: () => Promise<void>;
	saveConfig: () => Promise<void>;
	updateConfigField: (key: string, value: string) => void;
	cronStatus: () => Promise<unknown>;
	cronList: (params?: {
		includeDisabled?: boolean;
	}) => Promise<{ jobs?: unknown[] }>;
	cronAdd: (params: unknown) => Promise<unknown>;
	cronUpdate: (params: {
		id?: string;
		jobId?: string;
		patch: unknown;
	}) => Promise<unknown>;
	cronRemove: (params: {
		id?: string;
		jobId?: string;
	}) => Promise<{ ok?: boolean }>;
	cronRun: (params: {
		id?: string;
		jobId?: string;
		mode?: "due" | "force";
	}) => Promise<{ ok?: boolean }>;
	cronRuns: (params: {
		id?: string;
		jobId?: string;
		limit?: number;
	}) => Promise<{ entries?: unknown[] }>;
	channelsList: (params?: { includeDisabled?: boolean; limit?: number }) => Promise<{
		entries?: unknown[];
	}>;
	channelsPatch: (params: {
		key: string;
		enabled?: boolean;
		label?: string | null;
		requireMention?: boolean;
		allowUserIds?: string[];
		skillsAllowlist?: string[];
		skillsDenylist?: string[];
		systemPrompt?: string | null;
	}) => Promise<unknown>;
	sendChat: (params: {
		text: string;
		files?: Array<{ mediaType: string; url: string; filename?: string }>;
		webSearchEnabled?: boolean;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	}) => Promise<{ messages?: string[] }>;
	streamChat: (params: {
		text: string;
		files?: Array<{ mediaType: string; url: string; filename?: string }>;
		webSearchEnabled?: boolean;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	}) => Promise<{ stream: ReadableStream<unknown>; streamId: string }>;
	abortChat: (streamId: string) => Promise<{ ok: boolean }>;
	skillsStatus: () => Promise<import("@/lib/skills-types").SkillStatusReport>;
	skillsUpdate: (params: {
		skillKey: string;
		enabled?: boolean;
		env?: Record<string, string>;
	}) => Promise<{ ok: boolean; skillKey: string }>;
	skillsInstall: (params: {
		name: string;
		installId: string;
		timeoutMs?: number;
	}) => Promise<{ ok?: boolean; message?: string }>;
	sessionsList: (params?: {
		activeMinutes?: number | string;
		limit?: number | string;
		includeGlobal?: boolean;
		includeUnknown?: boolean;
		label?: string;
		spawnedBy?: string;
		agentId?: string;
	}) => Promise<unknown>;
	sessionsPatch: (params: {
		key: string;
		thinkingLevel?: string | null;
		verboseLevel?: string | null;
		reasoningLevel?: string | null;
		label?: string | null;
		spawnedBy?: string | null;
		agentId?: string | null;
		responseUsage?: "off" | "tokens" | "full" | "on" | null;
		sendPolicy?: "allow" | "deny" | null;
		groupActivation?: "mention" | "always" | null;
		execHost?: string | null;
		execSecurity?: string | null;
		execAsk?: string | null;
		execNode?: string | null;
		model?: string | null;
	}) => Promise<unknown>;
	sessionsReset: (params: { key: string }) => Promise<unknown>;
	sessionsDelete: (params: {
		key: string;
	}) => Promise<unknown>;
	sessionsResolve: (params: {
		key?: string;
		label?: string;
		spawnedBy?: string;
		agentId?: string;
	}) => Promise<unknown>;
};

const SETTINGS_KEY = "omni_admin_settings";

const GatewayContext = createContext<GatewayContextValue | null>(null);

function resolveDefaultBaseUrl(envBase: string) {
	if (envBase) return envBase;
	if (typeof window === "undefined") return "";
	const proto = window.location.protocol === "https:" ? "https" : "http";
	return `${proto}://${window.location.host}`;
}

function loadSettings(): AdminSettings | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(SETTINGS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<AdminSettings>;
		return {
			baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
			token: typeof parsed.token === "string" ? parsed.token : "",
		};
	} catch {
		return null;
	}
}

function saveSettings(settings: AdminSettings) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function GatewayProvider({ children }: { children: React.ReactNode }) {
	const envBase = process.env.NEXT_PUBLIC_ADMIN_API_BASE ?? "";
	const [baseUrl, setBaseUrl] = useState(envBase);
	const [token, setToken] = useState("");
	const [status, setStatus] = useState<AdminStatus | null>(null);
	const [config, setConfig] = useState<GatewayConfig>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configSaving, setConfigSaving] = useState(false);
	const [configError, setConfigError] = useState<string | null>(null);
	const clientRef = useRef<GatewayClient | null>(null);
	const connectingRef = useRef<Promise<void> | null>(null);
	const [autoConnect, setAutoConnect] = useState(false);
	const autoConnectTriggered = useRef(false);

	useEffect(() => {
		const defaultBase = resolveDefaultBaseUrl(envBase);
		const saved = loadSettings();
		if (saved) {
			setBaseUrl(saved.baseUrl || defaultBase);
			setToken(saved.token || "");
			setAutoConnect(Boolean(saved.baseUrl));
			return;
		}
		if (defaultBase) {
			setBaseUrl(defaultBase);
		}
	}, [envBase]);

	useEffect(() => {
		return () => {
			clientRef.current?.close();
		};
	}, []);


	// Internal function that ensures we have a connected client, reusing existing connection
	const ensureConnected = useCallback(async (): Promise<GatewayClient> => {
		// If already connecting, wait for that to finish
		if (connectingRef.current) {
			await connectingRef.current;
			if (clientRef.current) return clientRef.current;
		}

		// If we have a client, return it (GatewayClient.ensureOpen handles reconnection internally)
		if (clientRef.current) {
			return clientRef.current;
		}

		if (!baseUrl) {
			throw new Error("Gateway URL is not set");
		}

		// Create new client and connect
		const connectPromise = (async () => {
			saveSettings({ baseUrl, token });
			const client = new GatewayClient({ url: baseUrl, token });
			clientRef.current = client;
			const payload = (await client.connect()) as GatewayConnectPayload;
			setStatus(payload.status as AdminStatus);
			setConfig(payload.config ?? {});
		})();

		connectingRef.current = connectPromise;
		try {
			await connectPromise;
		} finally {
			connectingRef.current = null;
		}

		if (!clientRef.current) {
			throw new Error("Failed to connect");
		}
		return clientRef.current;
	}, [baseUrl, token]);

	// Public connect function - forces a reconnect (used by Refresh button)
	const connect = useCallback(async () => {
		if (!baseUrl) {
			setError("Gateway URL is not set");
			setStatus(null);
			return;
		}
		setLoading(true);
		setError(null);
		setConfigError(null);

		// Close existing client to force fresh connection
		clientRef.current?.close();
		clientRef.current = null;

		try {
			await ensureConnected();
		} catch (err) {
			setStatus(null);
			setConfig({});
			setError(err instanceof Error ? err.message : "Failed to load status");
		} finally {
			setLoading(false);
		}
	}, [baseUrl, ensureConnected]);

	useEffect(() => {
		if (!autoConnect || autoConnectTriggered.current) return;
		if (!baseUrl) return;
		autoConnectTriggered.current = true;
		void connect();
	}, [autoConnect, baseUrl, connect]);

	const updateConfigField = useCallback((key: string, value: string) => {
		setConfig((prev) => ({ ...prev, [key]: value }));
	}, []);

	const saveConfig = useCallback(async () => {
		if (!clientRef.current) {
			setConfigError("Connect to the gateway first.");
			return;
		}
		setConfigSaving(true);
		setConfigError(null);
		try {
			const next = await clientRef.current.setConfig(config);
			setConfig(next);
		} catch (err) {
			setConfigError(
				err instanceof Error ? err.message : "Failed to save config",
			);
		} finally {
			setConfigSaving(false);
		}
	}, [config]);

	const cronStatus = useCallback(async () => {
		const client = await ensureConnected();
		return client.cronStatus();
	}, [ensureConnected]);

	const cronList = useCallback(
		async (params?: { includeDisabled?: boolean }) => {
			const client = await ensureConnected();
			return client.cronList(params);
		},
		[ensureConnected],
	);

	const cronAdd = useCallback(
		async (params: unknown) => {
			const client = await ensureConnected();
			return client.cronAdd(params);
		},
		[ensureConnected],
	);

	const cronUpdate = useCallback(
		async (params: { id?: string; jobId?: string; patch: unknown }) => {
			const client = await ensureConnected();
			return client.cronUpdate(params);
		},
		[ensureConnected],
	);

	const cronRemove = useCallback(
		async (params: { id?: string; jobId?: string }) => {
			const client = await ensureConnected();
			return client.cronRemove(params);
		},
		[ensureConnected],
	);

	const cronRun = useCallback(
		async (params: { id?: string; jobId?: string; mode?: "due" | "force" }) => {
			const client = await ensureConnected();
			return client.cronRun(params);
		},
		[ensureConnected],
	);

	const cronRuns = useCallback(
		async (params: { id?: string; jobId?: string; limit?: number }) => {
			const client = await ensureConnected();
			return client.cronRuns(params);
		},
		[ensureConnected],
	);

	const channelsList = useCallback(
		async (params?: { includeDisabled?: boolean; limit?: number }) => {
			const client = await ensureConnected();
			return client.channelsList(params ?? {});
		},
		[ensureConnected],
	);

	const channelsPatch = useCallback(
		async (params: {
			key: string;
			enabled?: boolean;
			label?: string | null;
			requireMention?: boolean;
			allowUserIds?: string[];
			skillsAllowlist?: string[];
			skillsDenylist?: string[];
			systemPrompt?: string | null;
		}) => {
			const client = await ensureConnected();
			return client.channelsPatch(params);
		},
		[ensureConnected],
	);

	const sendChat = useCallback(
		async (params: {
			text: string;
			files?: Array<{ mediaType: string; url: string; filename?: string }>;
			webSearchEnabled?: boolean;
			chatId?: string;
			userId?: string;
			userName?: string;
			chatType?: "private" | "group" | "supergroup" | "channel";
		}) => {
			const client = await ensureConnected();
			return client.chatSend(params);
		},
		[ensureConnected],
	);

	const streamChat = useCallback(
		async (params: {
			text: string;
			files?: Array<{ mediaType: string; url: string; filename?: string }>;
			webSearchEnabled?: boolean;
			chatId?: string;
			userId?: string;
			userName?: string;
			chatType?: "private" | "group" | "supergroup" | "channel";
		}) => {
			const client = await ensureConnected();
			return client.chatStream(params);
		},
		[ensureConnected],
	);

	const abortChat = useCallback(async (streamId: string) => {
		if (!clientRef.current) {
			throw new Error("Connect to the gateway first.");
		}
		return clientRef.current.abortChat(streamId);
	}, []);

	const skillsStatus = useCallback(async () => {
		const client = await ensureConnected();
		return client.skillsStatus();
	}, [ensureConnected]);

	const skillsUpdate = useCallback(
		async (params: {
			skillKey: string;
			enabled?: boolean;
			env?: Record<string, string>;
		}) => {
			const client = await ensureConnected();
			return client.skillsUpdate(params);
		},
		[ensureConnected],
	);

	const skillsInstall = useCallback(
		async (params: { name: string; installId: string; timeoutMs?: number }) => {
			const client = await ensureConnected();
			return client.skillsInstall(params);
		},
		[ensureConnected],
	);

	const sessionsList = useCallback(
		async (params?: {
			activeMinutes?: number | string;
			limit?: number | string;
			includeGlobal?: boolean;
			includeUnknown?: boolean;
			label?: string;
			spawnedBy?: string;
			agentId?: string;
		}) => {
			const client = await ensureConnected();
			return client.sessionsList(params);
		},
		[ensureConnected],
	);

	const sessionsPatch = useCallback(
		async (params: {
			key: string;
			thinkingLevel?: string | null;
			verboseLevel?: string | null;
			reasoningLevel?: string | null;
			label?: string | null;
			spawnedBy?: string | null;
			agentId?: string | null;
			responseUsage?: "off" | "tokens" | "full" | "on" | null;
			sendPolicy?: "allow" | "deny" | null;
			groupActivation?: "mention" | "always" | null;
			execHost?: string | null;
			execSecurity?: string | null;
			execAsk?: string | null;
			execNode?: string | null;
			model?: string | null;
		}) => {
			const client = await ensureConnected();
			return client.sessionsPatch(params);
		},
		[ensureConnected],
	);

	const sessionsReset = useCallback(
		async (params: { key: string }) => {
			const client = await ensureConnected();
			return client.sessionsReset(params);
		},
		[ensureConnected],
	);

	const sessionsDelete = useCallback(
		async (params: { key: string }) => {
			const client = await ensureConnected();
			return client.sessionsDelete(params);
		},
		[ensureConnected],
	);

	const sessionsResolve = useCallback(
		async (params: {
			key?: string;
			label?: string;
			spawnedBy?: string;
			agentId?: string;
		}) => {
			const client = await ensureConnected();
			return client.sessionsResolve(params);
		},
		[ensureConnected],
	);

	const value = useMemo(
		() => ({
			baseUrl,
			token,
			status,
			config,
			loading,
			error,
			configSaving,
			configError,
			setBaseUrl,
			setToken,
			connect,
			saveConfig,
			updateConfigField,
			cronStatus,
			cronList,
			cronAdd,
			cronUpdate,
			cronRemove,
			cronRun,
			cronRuns,
			channelsList,
			channelsPatch,
			sendChat,
			streamChat,
			abortChat,
			skillsStatus,
			skillsUpdate,
			skillsInstall,
			sessionsList,
			sessionsPatch,
			sessionsReset,
			sessionsDelete,
			sessionsResolve,
		}),
		[
			baseUrl,
			token,
			status,
			config,
			loading,
			error,
			configSaving,
			configError,
			connect,
			saveConfig,
			updateConfigField,
			cronStatus,
			cronList,
			cronAdd,
			cronUpdate,
			cronRemove,
			cronRun,
			cronRuns,
			channelsList,
			channelsPatch,
			sendChat,
			streamChat,
			abortChat,
			skillsStatus,
			skillsUpdate,
			skillsInstall,
			sessionsList,
			sessionsPatch,
			sessionsReset,
			sessionsDelete,
			sessionsResolve,
		],
	);

	return (
		<GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
	);
}

export function useGateway() {
	const ctx = useContext(GatewayContext);
	if (!ctx) {
		throw new Error("useGateway must be used within GatewayProvider.");
	}
	return ctx;
}
