#!/usr/bin/env npx tsx

/**
 * Fetches available models from Portkey API and generates models.generated.ts
 *
 * Usage:
 *   npx tsx generate-portkey-models.ts
 *
 * Requires PORTKEY_API_KEY environment variable to fetch models list.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const excludedProviders = new Set([
	"bedrock", // flaky due to rate limits
	"gcp-gemini",
	"ovh",
]);

const excludedModelPatterns = [
	// not useful
	/embedding/i,
	/imagen/i,
	/-tuning$/,

	/^gpt-4/, // too old
	/^gpt-5-/, // causes errors because of different api style
	/gpt-oss/i,
	/@default/i, // causes errors
];

function shouldInclude(provider: string, model: string): boolean {
	if (excludedProviders.has(provider)) return false;
	if (excludedModelPatterns.some((p) => p.test(model))) return false;
	// vertex-ai: only Claude models
	if (provider === "vertex-ai" && !model.startsWith("anthropic.")) return false;
	return true;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PortkeyModel {
	id: string;
	slug: string;
	canonical_slug: string;
	object: string;
}

interface PortkeyModelsResponse {
	object: string;
	total: number;
	data: PortkeyModel[];
}

interface PortkeyPricing {
	pay_as_you_go?: {
		request_token?: { price?: number };
		response_token?: { price?: number };
		cache_read_input_token?: { price?: number };
		cache_write_input_token?: { price?: number };
	};
	type?: {
		primary?: string;
		supported?: { type?: string }[];
	};
	params?: { key?: string; defaultValue?: unknown; maxValue?: number }[];
}

type ApiType = "anthropic-messages" | "openai-responses" | "openai-completions";

interface GeneratedModel {
	id: string;
	name: string;
	api: ApiType;
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
}

const apiByProvider: Record<string, ApiType> = {
	"azure-openai-foundry": "openai-responses",
};

function determineApiType(provider: string, model: string): ApiType {
	if (provider === "vertex-ai" && model.startsWith("anthropic."))
		return "anthropic-messages";
	return apiByProvider[provider] ?? "openai-completions";
}

function parseModelId(id: string) {
	// Format: @provider-slug/model-slug
	const match = id.match(/^@([^/]+)\/(.+)$/);
	if (!match) return null;
	return { provider: match[1], model: match[2] };
}

const providerMapping: Record<string, string> = {
	"azure-openai-foundry": "azure-openai",
	"gcp-gemini": "google",
};

function normalizeProviderForPricing(provider: string, model: string) {
	if (provider === "vertex-ai" && model.startsWith("anthropic."))
		return "anthropic";
	return providerMapping[provider] ?? provider;
}

function normalizeModelForPricing(model: string): string {
	if (!model.startsWith("anthropic.")) return model;
	return model
		.replace(/^anthropic\./, "")
		.replace(/@/, "-")
		.replace(/@default$/, "");
}

async function fetchPricing(
	provider: string,
	model: string,
	canonicalSlug?: string,
): Promise<PortkeyPricing | null> {
	const normalizedProvider = normalizeProviderForPricing(provider, model);
	const normalizedModel = normalizeModelForPricing(model);

	// Try normalized model first, then fallbacks
	const slugsToTry = [normalizedModel];
	if (model !== normalizedModel && !slugsToTry.includes(model)) {
		slugsToTry.push(model);
	}
	if (canonicalSlug && !slugsToTry.includes(canonicalSlug)) {
		slugsToTry.push(canonicalSlug);
	}

	for (const slug of slugsToTry) {
		try {
			const url = `https://api.portkey.ai/model-configs/pricing/${normalizedProvider}/${slug}`;
			const response = await fetch(url);
			if (!response.ok) continue;
			const text = await response.text();
			if (text.includes("not found")) continue;
			return JSON.parse(text);
		} catch {}
	}
	return null;
}

const reasoningPatterns = [
	/o1/,
	/o3/,
	/o4/,
	/thinking/,
	/reasoner/,
	/deepseek-r1/,
	/claude.*(opus|sonnet)/,
	/gemini.*2\.5/,
	/gpt-5/,
];
const imagePatterns = [/vision/, /gpt-4/, /gpt-5/, /claude/, /gemini/];

function inferModelCapabilities(
	modelId: string,
	pricing: PortkeyPricing | null,
) {
	const id = modelId.toLowerCase();
	const reasoning = reasoningPatterns.some((p) => p.test(id));
	const supportsImage =
		imagePatterns.some((p) => p.test(id)) ||
		pricing?.type?.supported?.some((s) => s.type === "image");
	const input: ("text" | "image")[] = supportsImage
		? ["text", "image"]
		: ["text"];

	let contextWindow = 128000,
		maxTokens = 8192;
	if (id.includes("claude")) {
		contextWindow = 200000;
		maxTokens = id.includes("opus") ? 32000 : 64000;
	} else if (/gemini-2\.[05]/.test(id)) {
		contextWindow = 1048576;
		maxTokens = 65536;
	} else if (/gpt-[45]/.test(id)) {
		contextWindow = 128000;
		maxTokens = 16384;
	} else if (id.includes("deepseek")) {
		contextWindow = 64000;
		maxTokens = 8192;
	}

	return { reasoning, input, contextWindow, maxTokens };
}

const wordMap: Record<string, string> = {
	gpt: "GPT",
	ai: "AI",
	pro: "Pro",
	mini: "Mini",
	nano: "Nano",
	preview: "Preview",
	claude: "Claude",
	gemini: "Gemini",
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
	flash: "Flash",
	embedding: "Embedding",
	ada: "Ada",
	codex: "Codex",
	chat: "Chat",
	text: "Text",
};

function formatModelName(slug: string, canonicalSlug: string): string {
	const base = (canonicalSlug || slug)
		.replace(/^[a-z]{2}\./, "") // region prefixes
		.replace(/^anthropic\./, "") // provider prefix
		.replace(/:\d+$/, "") // version suffix
		.replace(/-\d{8}(-v\d+)?$/, "") // date suffixes
		.replace(/@\d+$/, ""); // @version suffixes

	return base
		.replace(/_/g, " ")
		.split("-")
		.map((word) => {
			const lower = word.toLowerCase();
			return (
				wordMap[lower] ??
				(/^\d+\.\d+$/.test(word)
					? word
					: word.charAt(0).toUpperCase() + word.slice(1))
			);
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchModels(): Promise<PortkeyModel[]> {
	const apiKey = process.env.PORTKEY_API_KEY;
	if (!apiKey) {
		throw new Error("PORTKEY_API_KEY environment variable is required");
	}

	console.log("Fetching models from Portkey API...");
	const response = await fetch("https://api.portkey.ai/v1/models", {
		headers: {
			"x-portkey-api-key": apiKey,
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch models: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as PortkeyModelsResponse;
	console.log(`Fetched ${data.total} models from Portkey`);
	return data.data;
}

async function generateModels() {
	const models = await fetchModels();
	const generatedModels: GeneratedModel[] = [];

	console.log("Fetching pricing information...");
	let processed = 0;

	for (const model of models) {
		const parsed = parseModelId(model.id);
		if (!parsed) {
			console.warn(`Skipping model with invalid ID format: ${model.id}`);
			continue;
		}

		if (!shouldInclude(parsed.provider, parsed.model)) continue;

		const pricing = await fetchPricing(
			parsed.provider,
			parsed.model,
			model.canonical_slug,
		);
		const capabilities = inferModelCapabilities(model.id, pricing);

		// Portkey API returns prices in cents per token, pi expects $/million tokens
		const toMillionDollars = (cents: number) =>
			parseFloat((cents * 10_000).toPrecision(10));
		const inputCost = toMillionDollars(
			pricing?.pay_as_you_go?.request_token?.price ?? 0,
		);
		const outputCost = toMillionDollars(
			pricing?.pay_as_you_go?.response_token?.price ?? 0,
		);
		const cacheReadCost = toMillionDollars(
			pricing?.pay_as_you_go?.cache_read_input_token?.price ?? 0,
		);
		const cacheWriteCost = toMillionDollars(
			pricing?.pay_as_you_go?.cache_write_input_token?.price ?? 0,
		);

		generatedModels.push({
			id: model.id,
			name: formatModelName(model.slug, model.canonical_slug),
			api: determineApiType(parsed.provider, parsed.model),
			reasoning: capabilities.reasoning,
			input: capabilities.input,
			cost: {
				input: inputCost,
				output: outputCost,
				cacheRead: cacheReadCost,
				cacheWrite: cacheWriteCost,
			},
			contextWindow: capabilities.contextWindow,
			maxTokens: capabilities.maxTokens,
		});

		processed++;
		if (processed % 50 === 0) {
			console.log(`  Processed ${processed}/${models.length} models...`);
		}
	}

	console.log(`Processed ${generatedModels.length} models`);

	// Generate TypeScript file
	const sortedModels = generatedModels.sort((a, b) => a.id.localeCompare(b.id));

	// Group models by API type
	const groupedModels: Record<ApiType, Record<string, GeneratedModel>> = {
		"anthropic-messages": {},
		"openai-responses": {},
		"openai-completions": {},
	};
	for (const model of sortedModels) {
		groupedModels[model.api][model.id] = model;
	}

	const output = `// Auto-generated by scripts/generate-portkey-models.ts - DO NOT edit manually

export type ApiType = "anthropic-messages" | "openai-responses" | "openai-completions";

export interface PortkeyModel {
	id: string;
	name: string;
	api: ApiType;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const PORTKEY_MODELS: Record<ApiType, Record<string, PortkeyModel>> = ${JSON.stringify(groupedModels, null, "\t")};
`;

	const outputPath = join(
		__dirname,
		"..",
		"pi-extensions",
		"portkey-provider",
		"portkey-models.generated.ts",
	);
	writeFileSync(outputPath, output);
	console.log(`\nGenerated ${outputPath}`);

	// Print statistics
	const reasoningModels = sortedModels.filter((m) => m.reasoning).length;
	console.log(`\nStatistics:`);
	console.log(`  Total models: ${sortedModels.length}`);
	console.log(`  Reasoning-capable: ${reasoningModels}`);
}

generateModels().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
