import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, formatAgentList } from "./agents.js";
import { runSubagent, type SubagentToolCall } from "./runner.js";

const ToolParams = Type.Object({
	agent: Type.String({
		description: "Name of the subagent to invoke, e.g. scout",
	}),
	task: Type.String({ description: "Task to delegate to the subagent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the subagent process" }),
	),
});

interface ToolDetails {
	agent: string;
	agentSource?: AgentConfig["source"];
	task: string;
	model?: string;
	exitCode: number;
	stopReason?: string;
	stderr?: string;
	toolCalls: SubagentToolCall[];
	running?: boolean;
	availableAgents?: string;
}

function pickModel(
	models: Model<Api>[],
	exact: string[],
	includes: string[],
): Model<Api> | undefined {
	const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
	for (const id of exact) {
		const match = byId.get(id.toLowerCase());
		if (match) return match;
	}
	for (const pattern of includes) {
		const lowerPattern = pattern.toLowerCase();
		const match = models.find(
			(model) =>
				model.id.toLowerCase().includes(lowerPattern) ||
				model.name.toLowerCase().includes(lowerPattern) ||
				`${model.provider}/${model.id}`.toLowerCase().includes(lowerPattern),
		);
		if (match) return match;
	}
	return undefined;
}

function resolveModel(
	model: string | undefined,
	models: Model<Api>[],
): string | undefined {
	if (!model || model !== "auto-fast") return model;
	const selected = pickModel(
		models,
		[
			"gemini-3-flash-preview",
			"claude-haiku-4-5",
			"claude-haiku-4.5",
			"gemini-2.5-flash",
			"gpt-5.4-mini",
		],
		["haiku", "flash", "mini", "fast"],
	);
	return selected ? `${selected.provider}/${selected.id}` : undefined;
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const discovery = discoverAgents(ctx.cwd);
		const summary = formatAgentList(discovery.agents);
		ctx.ui.notify(`Subagents available:\n${summary || "none"}`, "info");
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a named subagent with isolated context. Built-in scout is available by default; user agents can be added as markdown files in ~/.pi/agent/agents.",
		parameters: ToolParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task.trim();
			const discovery = discoverAgents(ctx.cwd);
			const availableAgents = formatAgentList(discovery.agents);
			const agent = discovery.agents.find(
				(candidate) => candidate.name === params.agent,
			);

			if (!task) {
				return {
					isError: true,
					content: [{ type: "text", text: "Task is required." }],
					details: {
						agent: params.agent,
						task,
						exitCode: 1,
						toolCalls: [],
						availableAgents,
					} as ToolDetails,
				};
			}

			if (!agent) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Unknown subagent: ${params.agent}\n\nAvailable agents:\n${availableAgents || "none"}`,
						},
					],
					details: {
						agent: params.agent,
						task,
						exitCode: 1,
						toolCalls: [],
						availableAgents,
					} as ToolDetails,
				};
			}

			const selectedModel = resolveModel(
				agent.model,
				ctx.modelRegistry.getAvailable(),
			);
			const baseDetails: ToolDetails = {
				agent: agent.name,
				agentSource: agent.source,
				task,
				model: selectedModel,
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
					task,
					systemPrompt: agent.systemPrompt,
					model: selectedModel,
					tools: agent.tools,
					signal,
					onProgress: onUpdate
						? (state) => {
								onUpdate({
									content: [
										{ type: "text", text: state.text || "(running...)" },
									],
									details: {
										...baseDetails,
										model: state.model ?? selectedModel,
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
					agent: agent.name,
					agentSource: agent.source,
					task,
					model: run.model ?? selectedModel,
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
				return {
					isError: true,
					content: [{ type: "text", text: message }],
					details: {
						...baseDetails,
						exitCode: 1,
						stopReason: message.toLowerCase().includes("aborted")
							? "aborted"
							: "error",
						running: false,
					} as ToolDetails,
				};
			}
		},
		renderCall(args, theme) {
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", args.agent || "...") +
				"\n" +
				theme.fg("dim", args.task || "...");
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
			const isError = Boolean((result as { isError?: boolean }).isError);

			const status =
				details?.running || isPartial
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
			if (details) {
				lines.push(
					`${status} ${theme.fg("toolTitle", theme.bold(details.agent))}${details.agentSource ? theme.fg("muted", ` (${details.agentSource})`) : ""}${details.model ? theme.fg("dim", ` ${details.model}`) : ""}`,
				);
			}

			if (shownToolCalls.length > 0) {
				lines.push(theme.fg("muted", `🔧 calls (${toolCalls.length}):`));
				for (const toolCall of shownToolCalls)
					lines.push(theme.fg("dim", `  → ${formatToolCall(toolCall)}`));
				if (!expanded && toolCalls.length > shownToolCalls.length)
					lines.push(
						theme.fg(
							"dim",
							`  ... ${toolCalls.length - shownToolCalls.length} more`,
						),
					);
			}

			lines.push(isError ? theme.fg("error", shownOutput) : shownOutput);
			if (
				!expanded &&
				(outputLines.length > 10 || toolCalls.length > shownToolCalls.length)
			)
				lines.push(theme.fg("dim", "(Ctrl+O to expand)"));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
