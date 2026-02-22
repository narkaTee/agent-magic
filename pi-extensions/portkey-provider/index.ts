/**
 * Portkey Provider Extension
 *
 * Exposes models from Portkey (Claude via Vertex AI, GPT via Azure OpenAI Foundry, etc.)
 *
 * Usage:
 *   PORTKEY_API_KEY=your-key pi
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type ApiType,
	PORTKEY_MODELS,
	type PortkeyModel,
} from "./portkey-models.generated.js";

const apiBaseUrls: Record<ApiType, string> = {
	"anthropic-messages": "https://api.portkey.ai",
	"openai-responses": "https://api.portkey.ai/v1",
	"openai-completions": "https://api.portkey.ai/v1",
};

function toProviderModels(models: Record<string, PortkeyModel>) {
	return Object.values(models).map((m) => ({
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	}));
}

export default function (pi: ExtensionAPI) {
	for (const [apiType, models] of Object.entries(PORTKEY_MODELS)) {
		const modelList = toProviderModels(models);
		if (modelList.length === 0) continue;

		pi.registerProvider(`portkey-${apiType}`, {
			baseUrl: apiBaseUrls[apiType as ApiType],
			apiKey: "!echo $PORTKEY_API_KEY",
			api: apiType as ApiType,
			authHeader: false,
			headers: {
				"x-portkey-api-key": "!echo $PORTKEY_API_KEY",
			},
			models: modelList,
		});
	}
}
