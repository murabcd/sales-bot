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
	admin?: { authRequired?: boolean; allowlist?: string[] };
	cron?: {
		enabled?: boolean;
		chatId?: string;
		timezone?: string;
		sprintFilter?: string;
	};
	summary?: { enabled?: boolean; model?: string };
	gateway?: {
		plugins?: {
			configured?: string[];
			allowlist?: string[];
			denylist?: string[];
			active?: string[];
		};
	};
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
	runCron: () => Promise<{ ok: boolean; blocks?: number; error?: string }>;
	sendChat: (params: {
		text: string;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	}) => Promise<{ messages?: string[] }>;
	streamChat: (params: {
		text: string;
		chatId?: string;
		userId?: string;
		userName?: string;
		chatType?: "private" | "group" | "supergroup" | "channel";
	}) => Promise<{ stream: ReadableStream<unknown>; streamId: string }>;
	abortChat: (streamId: string) => Promise<{ ok: boolean }>;
};

const SETTINGS_KEY = "omni_admin_settings";

const GatewayContext = createContext<GatewayContextValue | null>(null);

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

	useEffect(() => {
		const saved = loadSettings();
		if (saved) {
			setBaseUrl(saved.baseUrl || envBase);
			setToken(saved.token || "");
		}
	}, [envBase]);

	useEffect(() => {
		return () => {
			clientRef.current?.close();
		};
	}, []);

	const connect = useCallback(async () => {
		if (!baseUrl) {
			setError("Gateway URL is not set");
			setStatus(null);
			return;
		}
		setLoading(true);
		setError(null);
		setConfigError(null);
		saveSettings({ baseUrl, token });
		try {
			clientRef.current?.close();
			const client = new GatewayClient({ url: baseUrl, token });
			clientRef.current = client;
			const payload = (await client.connect()) as GatewayConnectPayload;
			setStatus(payload.status as AdminStatus);
			setConfig(payload.config ?? {});
		} catch (err) {
			setStatus(null);
			setConfig({});
			setError(err instanceof Error ? err.message : "Failed to load status");
		} finally {
			setLoading(false);
		}
	}, [baseUrl, token]);

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

	const runCron = useCallback(async () => {
		if (!clientRef.current) {
			throw new Error("Connect to the gateway first.");
		}
		return clientRef.current.runCron();
	}, []);

	const sendChat = useCallback(
		async (params: {
			text: string;
			chatId?: string;
			userId?: string;
			userName?: string;
			chatType?: "private" | "group" | "supergroup" | "channel";
		}) => {
			if (!clientRef.current) {
				await connect();
			}
			if (!clientRef.current) {
				throw new Error("Connect to the gateway first.");
			}
			return clientRef.current.chatSend(params);
		},
		[connect],
	);

	const streamChat = useCallback(
		async (params: {
			text: string;
			chatId?: string;
			userId?: string;
			userName?: string;
			chatType?: "private" | "group" | "supergroup" | "channel";
		}) => {
			if (!clientRef.current) {
				await connect();
			}
			if (!clientRef.current) {
				throw new Error("Connect to the gateway first.");
			}
			return clientRef.current.chatStream(params);
		},
		[connect],
	);

	const abortChat = useCallback(async (streamId: string) => {
		if (!clientRef.current) {
			throw new Error("Connect to the gateway first.");
		}
		return clientRef.current.abortChat(streamId);
	}, []);

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
			runCron,
			sendChat,
			streamChat,
			abortChat,
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
			runCron,
			sendChat,
			streamChat,
			abortChat,
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
