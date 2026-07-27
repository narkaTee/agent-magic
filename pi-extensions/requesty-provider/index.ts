import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://router.eu.requesty.ai";
const MODELS_BASE_URL = `${BASE_URL}/v1`;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;

const CACHE_FILE = path.join(
	os.homedir(),
	".pi",
	"cache",
	"requesty-models.json",
);

function pricePerMillionTokens(value: unknown): number {
	const n = typeof value === "number" ? value : 0;
	return n * 1_000_000;
}

function apiKeyHash(apiKey: string): string {
	return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function isUsableModel(id: string): boolean {
	// Requesty exposes both Azure Chat Completions and Responses routes for GPT-5.5/5.6; the plain Azure routes fail with tools + reasoning.
	if (/^azure\/(?:gpt-5\.5|gpt-5\.6-(?:luna|sol|terra))@/.test(id)) {
		return false;
	}
	// nebius/glm-5.2 is present in the catalog but Requesty returns 404 for chat requests.
	if (id === "nebius/glm-5.2") return false;
	// nebius/google/gemma-3-27b-it emits markdown that looks like a tool call instead of actually calling tools.
	if (id === "nebius/google/gemma-3-27b-it") return false;
	return true;
}

function modelApiOverride(id: string): Pick<ModelEntry, "api" | "baseUrl"> {
	if (id.startsWith("mistral/")) {
		return { api: "openai-completions", baseUrl: MODELS_BASE_URL };
	}
	if (id.startsWith("bedrock/kimi-")) {
		// Bedrock Kimi rejects Anthropic thinking budgets translated as numeric reasoning_effort; OpenAI Chat keeps tool use and reasoning working.
		return { api: "openai-completions", baseUrl: MODELS_BASE_URL };
	}
	if (id.startsWith("bedrock/minimax-")) {
		// Bedrock MiniMax has the same Anthropic thinking-budget translation issue.
		return { api: "openai-completions", baseUrl: MODELS_BASE_URL };
	}
	if (id.startsWith("nebius/")) {
		return { api: "openai-completions", baseUrl: MODELS_BASE_URL };
	}
	return {};
}

type ModelEntry = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	api?: "openai-completions";
	baseUrl?: string;
};

type CacheFile = {
	version: number;
	fetchedAt: number;
	baseUrl: string;
	apiKeyHash: string;
	models: ModelEntry[];
};

function readCache(apiKey: string): ModelEntry[] | null {
	try {
		const raw = fs.readFileSync(CACHE_FILE, "utf8");
		const data = JSON.parse(raw) as CacheFile;
		if (
			data.version !== CACHE_VERSION ||
			data.baseUrl !== MODELS_BASE_URL ||
			data.apiKeyHash !== apiKeyHash(apiKey) ||
			Date.now() - data.fetchedAt > CACHE_TTL_MS
		) {
			return null;
		}
		return data.models;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[requesty-provider] cache read error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return null;
	}
}

function writeCache(apiKey: string, models: ModelEntry[]): void {
	try {
		fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
		const data: CacheFile = {
			version: CACHE_VERSION,
			fetchedAt: Date.now(),
			baseUrl: MODELS_BASE_URL,
			apiKeyHash: apiKeyHash(apiKey),
			models,
		};
		const tmp = `${CACHE_FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data));
		fs.renameSync(tmp, CACHE_FILE);
	} catch (err) {
		console.warn(
			`[requesty-provider] failed to write cache: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function fetchModels(apiKey: string): Promise<ModelEntry[]> {
	const response = await fetch(`${MODELS_BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as { data?: unknown[] };
	if (!payload || !Array.isArray(payload.data)) {
		throw new Error("Expected OpenAI-compatible response with a data array");
	}

	return payload.data
		.filter(
			(m): m is Record<string, unknown> =>
				m !== null &&
				typeof m === "object" &&
				typeof (m as Record<string, unknown>).id === "string" &&
				((m as Record<string, unknown>).id as string).length > 0 &&
				isUsableModel((m as Record<string, unknown>).id as string),
		)
		.map((m) => ({
			...modelApiOverride(m.id as string),
			id: m.id as string,
			name:
				typeof m.name === "string" && (m.name as string).length > 0
					? (m.name as string)
					: (m.id as string),
			reasoning: m.supports_reasoning === true,
			input: (m.supports_vision === true ? ["text", "image"] : ["text"]) as (
				| "text"
				| "image"
			)[],
			cost: {
				input: pricePerMillionTokens(m.input_price),
				output: pricePerMillionTokens(m.output_price),
				cacheRead: pricePerMillionTokens(m.cached_price),
				cacheWrite: pricePerMillionTokens(m.caching_price),
			},
			contextWindow:
				typeof m.context_window === "number"
					? m.context_window
					: DEFAULT_CONTEXT_WINDOW,
			maxTokens:
				typeof m.max_output_tokens === "number" && m.max_output_tokens > 0
					? m.max_output_tokens
					: DEFAULT_MAX_TOKENS,
		}));
}

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env.REQUESTY_API_KEY;
	if (!apiKey || apiKey.trim().length === 0) return;

	const registerModels = (models: ModelEntry[]) => {
		pi.registerProvider("requesty", {
			baseUrl: BASE_URL,
			apiKey: "!echo $REQUESTY_API_KEY",
			api: "anthropic-messages",
			headers: {
				"HTTP-Referer": "https://pi.dev",
				"X-Title": "Pi",
			},
			models,
		});
	};

	const cached = readCache(apiKey);
	if (cached && cached.length > 0) {
		registerModels(cached);
	} else {
		try {
			const models = await fetchModels(apiKey);
			if (models.length === 0) return;
			writeCache(apiKey, models);
			registerModels(models);
		} catch (error) {
			console.warn(
				`[requesty-provider] startup model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	pi.registerCommand("requesty-fetch-models", {
		description: "Force-refresh the cached Requesty model list",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const models = await fetchModels(apiKey);
				if (models.length === 0) {
					ctx.ui.notify(
						"[requesty-provider] fetch returned no models",
						"warning",
					);
					return;
				}
				writeCache(apiKey, models);
				ctx.ui.notify(
					`[requesty-provider] refreshed ${models.length} models — restart pi to apply`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`[requesty-provider] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
