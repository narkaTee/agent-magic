import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://router.eu.requesty.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

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
			data.baseUrl !== BASE_URL ||
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
			baseUrl: BASE_URL,
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
	const response = await fetch(`${BASE_URL}/models`, {
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
				((m as Record<string, unknown>).id as string).length > 0,
		)
		.map((m) => ({
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
				typeof m.max_output_tokens === "number"
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
			api: "openai-completions",
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
