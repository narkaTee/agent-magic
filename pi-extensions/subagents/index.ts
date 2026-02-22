import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { runSubagent, type SubagentToolCall } from "./runner.js";

const ToolParams = Type.Object({
	prompt: Type.String({ description: "Prompt to send to the subagent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the subagent process" }),
	),
});

interface ToolConfig {
	name: string;
	label: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	pickModel: (models: Model<Api>[]) => Model<Api> | undefined;
}

interface ToolDetails {
	tool: string;
	prompt: string;
	model?: string;
	exitCode: number;
	stopReason?: string;
	stderr?: string;
	toolCalls: SubagentToolCall[];
	running?: boolean;
}

function pickModel(
	models: Model<Api>[],
	exact: string[],
	includes: string[],
): Model<Api> | undefined {
	const byId = new Map(models.map((m) => [m.id.toLowerCase(), m]));
	for (const id of exact) {
		const match = byId.get(id.toLowerCase());
		if (match) return match;
	}
	for (const pattern of includes) {
		const p = pattern.toLowerCase();
		const match = models.find(
			(m) =>
				m.id.toLowerCase().includes(p) ||
				m.name.toLowerCase().includes(p) ||
				`${m.provider}/${m.id}`.toLowerCase().includes(p),
		);
		if (match) return match;
	}
	return undefined;
}

function getText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function formatToolCall(toolCall: SubagentToolCall): string {
	const args = JSON.stringify(toolCall.arguments ?? {});
	const preview = args.length > 90 ? `${args.slice(0, 90)}...` : args;
	return `${toolCall.name} ${preview}`;
}

const SCOUT_SYSTEM_PROMPT = `You are Scout, a fast codebase reconnaissance subagent.

Rules:
- Explore quickly and accurately.
- Use only read-only tooling.
- Never edit files.
- Prefer grep/find first, then read targeted ranges.

Output format:
1) Key findings
2) Relevant files with why each matters
3) Suggested next checks`;

const REVIEW_SYSTEM_PROMPT = `You are Review, a senior code review subagent.

Rules:
- Focus on correctness, maintainability, readability and security.
- Provide concrete issues with file paths and line references when possible.
- Use bash only for read-only git inspection (diff/log/show).
- Never modify files.

Output format:
1) Critical issues
2) Warnings
3) Suggestions
4) Overall assessment`;

function registerSubagentTool(pi: ExtensionAPI, config: ToolConfig) {
	let cachedAvailableModels: Model<Api>[] = [];
	const selectModel = (models: Model<Api>[]) =>
		config.pickModel(models) || models[0];
	const refreshAvailableModels = (ctx: {
		modelRegistry: { getAvailable(): Model<Api>[] };
	}) => {
		cachedAvailableModels = ctx.modelRegistry.getAvailable();
	};

	pi.on("session_start", async (_event, ctx) => refreshAvailableModels(ctx));
	pi.on("session_switch", async (_event, ctx) => refreshAvailableModels(ctx));
	pi.on("session_fork", async (_event, ctx) => refreshAvailableModels(ctx));

	pi.registerTool({
		name: config.name,
		label: config.label,
		description: config.description,
		parameters: ToolParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const prompt = params.prompt.trim();
			if (!prompt) {
				return {
					isError: true,
					content: [{ type: "text", text: "Prompt is required." }],
					details: {
						tool: config.name,
						prompt: "",
						exitCode: 1,
						toolCalls: [],
					} as ToolDetails,
				};
			}

			const availableModels = ctx.modelRegistry.getAvailable();
			cachedAvailableModels = availableModels;
			const selectedModel = selectModel(availableModels);
			if (!selectedModel) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "No models available from authenticated providers.",
						},
					],
					details: {
						tool: config.name,
						prompt,
						exitCode: 1,
						toolCalls: [],
					} as ToolDetails,
				};
			}

			const selectedModelRef = `${selectedModel.provider}/${selectedModel.id}`;

			const baseDetails: ToolDetails = {
				tool: config.name,
				prompt,
				model: selectedModelRef,
				exitCode: -1,
				toolCalls: [],
				running: true,
			};
			onUpdate?.({
				content: [{ type: "text", text: "(starting...)" }],
				details: baseDetails,
			});

			try {
				const run = await runSubagent({
					cwd: params.cwd ?? ctx.cwd,
					task: prompt,
					systemPrompt: config.systemPrompt,
					model: selectedModelRef,
					tools: config.tools,
					signal,
					onProgress: onUpdate
						? (state) => {
								onUpdate({
									content: [
										{ type: "text", text: state.text || "(running...)" },
									],
									details: {
										...baseDetails,
										model: state.model ?? selectedModelRef,
										stopReason: state.stopReason,
										toolCalls: state.toolCalls,
									},
								});
							}
						: undefined,
				});

				const isError =
					run.exitCode !== 0 ||
					run.stopReason === "error" ||
					run.stopReason === "aborted";
				const text = isError
					? run.errorMessage ||
						run.stderr.trim() ||
						run.finalText ||
						"(no output)"
					: run.finalText ||
						run.errorMessage ||
						run.stderr.trim() ||
						"(no output)";
				const details: ToolDetails = {
					tool: config.name,
					prompt,
					model: run.model ?? selectedModelRef,
					exitCode: run.exitCode,
					stopReason: run.stopReason,
					stderr: run.stderr.trim() || undefined,
					toolCalls: run.toolCalls,
					running: false,
				};
				return { isError, content: [{ type: "text", text }], details };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Subagent failed";
				const isAborted = message.toLowerCase().includes("aborted");
				return {
					isError: true,
					content: [{ type: "text", text: message }],
					details: {
						...baseDetails,
						exitCode: 1,
						stopReason: isAborted ? "aborted" : "error",
						running: false,
					},
				};
			}
		},
		renderCall(args, theme) {
			const detectedModel = selectModel(cachedAvailableModels);
			const modelLabel = detectedModel
				? `[${detectedModel.provider}/${detectedModel.id}]`
				: "";
			const text =
				theme.fg("toolTitle", theme.bold(`${config.name} `)) +
				theme.fg("muted", modelLabel) +
				"\n" +
				theme.fg("dim", args.prompt);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ToolDetails | undefined;
			const outputText =
				getText(
					result as { content: Array<{ type: string; text?: string }> },
				) || "(no output)";
			const outputLines = outputText.split("\n");
			const shownOutput = expanded
				? outputText
				: outputLines.slice(0, 10).join("\n");
			const toolCalls = details?.toolCalls ?? [];
			const shownToolCalls = expanded ? toolCalls : toolCalls.slice(-6);

			const lines: string[] = [];
			let header = "";
			if (details?.running || isPartial) {
				header += (header ? " " : "") + theme.fg("warning", "⏳");
			}
			if (header) lines.push(header);

			if (shownToolCalls.length > 0) {
				lines.push(theme.fg("muted", `🔧 calls (${toolCalls.length}):`));
				for (const toolCall of shownToolCalls) {
					lines.push(theme.fg("dim", `  → ${formatToolCall(toolCall)}`));
				}
				if (!expanded && toolCalls.length > shownToolCalls.length) {
					lines.push(
						theme.fg(
							"dim",
							`  ... ${toolCalls.length - shownToolCalls.length} more`,
						),
					);
				}
			}

			const isError = Boolean((result as { isError?: boolean }).isError);
			if (isError) {
				lines.push(theme.fg("error", shownOutput));
			} else {
				lines.push(shownOutput);
			}

			if (
				!expanded &&
				(outputLines.length > 10 || toolCalls.length > shownToolCalls.length)
			) {
				lines.push(theme.fg("dim", "(Ctrl+O to expand)"));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	registerSubagentTool(pi, {
		name: "scout",
		label: "Scout",
		description:
			"Run a fast exploration subagent with isolated context. Use for quick codebase discovery (files, call paths, dependencies, ownership). Skip for small, local, obvious changes.",
		systemPrompt: SCOUT_SYSTEM_PROMPT,
		tools: ["read", "grep", "find", "ls"],
		pickModel: (models) =>
			pickModel(
				models,
				[
					"gemini-3-flash-preview",
					"claude-haiku-4-5",
					"claude-haiku-4.5",
					"gemini-2.5-flash",
					"gpt-5.3-codex-spark",
				],
				["haiku", "flash", "mini", "fast"],
			),
	});

	registerSubagentTool(pi, {
		name: "review",
		label: "Review",
		description:
			"Run a code-review subagent with isolated context. Use when the user requests review/validation. Provide a concise summary of intended changes in the prompt.",
		systemPrompt: REVIEW_SYSTEM_PROMPT,
		tools: ["read", "grep", "find", "ls", "bash"],
		pickModel: (models) =>
			pickModel(
				models,
				[
					"gpt-5.3-codex",
					"claude-opus-4-6",
					"claude-opus-4.6",
					"gemini-3-pro-preview",
					"claude-sonnet-4-5",
					"claude-sonnet-4.5",
				],
				["sonnet", "gpt-5.3", "gemini"],
			),
	});
}
