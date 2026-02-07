import {
	getModels,
	refreshOpenAICodexToken,
	type Api,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const AUTH_ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URL = `${AUTH_ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_ISSUER}/deviceauth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type DeviceUserCodeResponse = {
	device_auth_id?: string;
	user_code?: string;
	usercode?: string;
	interval?: string | number;
};

type DeviceTokenResponse = {
	authorization_code?: string;
	code_verifier?: string;
	error?: string;
	error_description?: string;
};

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

function getCodexModelDefinitions() {
	return getModels("openai-codex").map((model: Model<Api>) => ({
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers,
		compat: model.compat,
	}));
}

function decodeJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(atob(parts[1] || "")) as JwtPayload;
	} catch {
		return null;
	}
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function parseIntervalSeconds(value: string | number | undefined): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return 5;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Login cancelled"));
		};

		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function exchangeAuthorizationCode(
	authorizationCode: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: authorizationCode,
			code_verifier: codeVerifier,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI token exchange failed: ${response.status} ${text}`);
	}

	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error("OpenAI token response missing fields");
	}

	const accountId = getAccountId(json.access_token);
	if (!accountId) {
		throw new Error("Failed to extract accountId from OpenAI token");
	}

	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		accountId,
	};
}

async function startDeviceFlow(): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds: number }> {
	const response = await fetch(DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				"Device code login is not enabled for this Account.",
			);
		}
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI device code start failed: ${response.status} ${text}`);
	}

	const json = (await response.json()) as DeviceUserCodeResponse;
	const deviceAuthId = json.device_auth_id;
	const userCode = json.user_code || json.usercode;

	if (!deviceAuthId || !userCode) {
		throw new Error("OpenAI device code response missing fields");
	}

	return {
		deviceAuthId,
		userCode,
		intervalSeconds: parseIntervalSeconds(json.interval),
	};
}

async function pollDeviceAuthorizationCode(
	deviceAuthId: string,
	userCode: string,
	intervalSeconds: number,
	signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
	const startedAt = Date.now();
	let pollEveryMs = Math.max(1000, intervalSeconds * 1000);

	while (Date.now() - startedAt < DEVICE_TIMEOUT_MS) {
		if (signal?.aborted) throw new Error("Login cancelled");

		const response = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: deviceAuthId,
				user_code: userCode,
			}),
			signal,
		});

		if (response.ok) {
			const json = (await response.json()) as DeviceTokenResponse;
			if (json.authorization_code && json.code_verifier) {
				return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
			}
			throw new Error("OpenAI device token response missing fields");
		}

		if (response.status === 403 || response.status === 404) {
			await sleep(pollEveryMs, signal);
			continue;
		}

		let detail = "";
		let retryable = false;
		try {
			const data = (await response.json()) as DeviceTokenResponse;
			const errorCode = data.error?.toLowerCase();
			if (errorCode === "authorization_pending") {
				retryable = true;
			}
			if (errorCode === "slow_down") {
				retryable = true;
				pollEveryMs += 5000;
			}
			if (data.error || data.error_description) {
				detail = `${data.error || "error"}${data.error_description ? `: ${data.error_description}` : ""}`;
			}
		} catch {
			const text = await response.text().catch(() => "");
			if (text) detail = text;
		}

		if (retryable) {
			await sleep(pollEveryMs, signal);
			continue;
		}

		throw new Error(`OpenAI device login failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}

	throw new Error("OpenAI device login timed out");
}

async function loginWithDeviceCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const started = await startDeviceFlow();
	callbacks.onAuth({
		url: DEVICE_VERIFICATION_URL,
		instructions: `Enter code: ${started.userCode}`,
	});
	callbacks.onProgress?.("Waiting for device authorization...");

	const pollResult = await pollDeviceAuthorizationCode(
		started.deviceAuthId,
		started.userCode,
		started.intervalSeconds,
		callbacks.signal,
	);
	return exchangeAuthorizationCode(pollResult.authorizationCode, pollResult.codeVerifier, DEVICE_REDIRECT_URI);
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	return loginWithDeviceCode(callbacks);
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return refreshOpenAICodexToken(credentials.refresh);
}

export default function openAICodexAuthExtension(pi: ExtensionAPI) {
	pi.registerProvider("openai-codex-device", {
		baseUrl: DEFAULT_BASE_URL,
		api: "openai-codex-responses",
		apiKey: "OPENAI_API_KEY",
		models: getCodexModelDefinitions(),
		oauth: {
			name: "ChatGPT Plus/Pro (Codex Subscription w/ Device Code)",
			login,
			refreshToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}
