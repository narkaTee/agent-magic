import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, formatAgentList } from "./agents.js";
import {
	runSubagent,
	type SubagentToolCall,
	type UsageStats,
} from "./runner.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the subagent to invoke" }),
	task: Type.String({ description: "Task to delegate to the subagent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for this subagent process" }),
	),
});

const ToolParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description:
				"Name of the subagent to invoke, e.g. scout. Omit for an ad-hoc isolated pi agent.",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate to the subagent" }),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the subagent process" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Parallel tasks to run as {agent, task, cwd?} items",
		}),
	),
});

type AgentSource = AgentConfig["source"] | "adhoc" | "unknown";

type SubagentMode = "single" | "parallel";

interface SubagentResult {
	agent: string;
	agentSource?: AgentSource;
	task: string;
	model?: string;
	exitCode: number;
	stopReason?: string;
	stderr?: string;
	finalText: string;
	toolCalls: SubagentToolCall[];
	usage?: UsageStats;
	malformedJsonLines?: number;
	running?: boolean;
	availableAgents?: string;
}

interface SubagentDetails {
	mode: SubagentMode;
	results: SubagentResult[];
}

interface ResolvedTask {
	agent: AgentConfig | undefined;
	agentName: string;
	agentSource: AgentSource;
	task: string;
	cwd?: string;
	model?: string;
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(
	usage: UsageStats | undefined,
	model: string | undefined,
): string {
	if (!usage) return model ?? "";
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatDetailedAgentList(agents: AgentConfig[]): string {
	return agents
		.map((agent) => {
			const details = [
				`source: ${agent.source}`,
				agent.model ? `model: ${agent.model}` : undefined,
				agent.tools?.length
					? `tools: ${agent.tools.join(", ")}`
					: "tools: default",
			]
				.filter(Boolean)
				.join(", ");
			return `${agent.name} (${details})\n  ${agent.description}`;
		})
		.join("\n\n");
}

function isFailed(result: SubagentResult): boolean {
	return (
		result.exitCode !== -1 &&
		(result.exitCode !== 0 ||
			result.stopReason === "error" ||
			result.stopReason === "aborted")
	);
}

function statusLabel(result: SubagentResult): string {
	if (result.exitCode === -1 || result.running) return "running";
	if (!isFailed(result)) return "completed";
	return `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`;
}

function resultOutput(result: SubagentResult): string {
	return result.finalText || result.stderr || "(no output)";
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	signal: AbortSignal | undefined,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOut>(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(undefined).map(async () => {
		while (true) {
			if (signal?.aborted) throw new Error("Subagent aborted");
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function aggregateStatus(results: SubagentResult[]): string {
	const running = results.filter((result) => result.exitCode === -1).length;
	const done = results.length - running;
	const failed = results.filter(isFailed).length;
	return `Parallel: ${done}/${results.length} done, ${failed} failed, ${running} running`;
}

function makePlaceholder(task: ResolvedTask): SubagentResult {
	return {
		agent: task.agentName,
		agentSource: task.agentSource,
		task: task.task,
		model: task.model,
		exitCode: -1,
		finalText: "",
		toolCalls: [],
		usage: emptyUsage(),
		running: true,
	};
}

async function runResolvedTask(
	resolved: ResolvedTask,
	defaultCwd: string,
	signal: AbortSignal | undefined,
	onProgress: ((result: SubagentResult) => void) | undefined,
): Promise<SubagentResult> {
	const base = makePlaceholder(resolved);
	try {
		const run = await runSubagent({
			cwd: resolved.cwd ?? defaultCwd,
			task: resolved.task,
			systemPrompt: resolved.agent?.systemPrompt ?? "",
			model: resolved.model,
			tools: resolved.agent?.tools,
			signal,
			onProgress: onProgress
				? (state) => {
						onProgress({
							...base,
							model: state.model ?? resolved.model,
							stopReason: state.stopReason,
							finalText: state.text,
							toolCalls: state.toolCalls,
							usage: state.usage,
						});
					}
				: undefined,
		});
		const finalText =
			run.exitCode !== 0 ||
			run.stopReason === "error" ||
			run.stopReason === "aborted"
				? run.errorMessage ||
					run.stderr.trim() ||
					run.finalText ||
					"(no output)"
				: run.finalText ||
					run.errorMessage ||
					run.stderr.trim() ||
					"(no output)";
		return {
			...base,
			model: run.model ?? resolved.model,
			exitCode: run.exitCode,
			stopReason: run.stopReason,
			stderr: run.stderr.trim() || undefined,
			finalText,
			toolCalls: run.toolCalls,
			usage: run.usage,
			malformedJsonLines: run.malformedJsonLines,
			running: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Subagent failed";
		return {
			...base,
			exitCode: 1,
			stopReason: message.toLowerCase().includes("aborted")
				? "aborted"
				: "error",
			finalText: message,
			running: false,
		};
	}
}

function resolveTask(
	agentName: string | undefined,
	task: string,
	cwd: string | undefined,
	agents: AgentConfig[],
	availableAgents: string,
	models: Model<Api>[],
): { resolved?: ResolvedTask; error?: SubagentResult } {
	const trimmedTask = task.trim();
	const namedAgent = agentName
		? agents.find((candidate) => candidate.name === agentName)
		: undefined;
	if (!trimmedTask) {
		return {
			error: {
				agent: agentName ?? "adhoc",
				task: trimmedTask,
				exitCode: 1,
				finalText: "Task is required.",
				toolCalls: [],
				availableAgents,
			},
		};
	}
	if (agentName && !namedAgent) {
		return {
			error: {
				agent: agentName,
				agentSource: "unknown",
				task: trimmedTask,
				exitCode: 1,
				finalText: `Unknown subagent: ${agentName}\n\nAvailable agents:\n${availableAgents || "none"}`,
				toolCalls: [],
				availableAgents,
			},
		};
	}
	return {
		resolved: {
			agent: namedAgent,
			agentName: namedAgent?.name ?? "adhoc",
			agentSource: namedAgent?.source ?? "adhoc",
			task: trimmedTask,
			cwd,
			model: resolveModel(namedAgent?.model, models),
		},
	};
}

function singleContent(result: SubagentResult): string {
	return resultOutput(result);
}

function parallelContent(results: SubagentResult[]): string {
	const successCount = results.filter((result) => !isFailed(result)).length;
	const summaries = results.map((result, index) => {
		const output = truncateOutput(resultOutput(result));
		return `### [${index + 1}. ${result.agent}] ${statusLabel(result)}\n\n${output}`;
	});
	return `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const discovery = discoverAgents(ctx.cwd);
		const summary = formatAgentList(discovery.agents);
		ctx.ui.notify(`Subagents available:\n${summary || "none"}`, "info");
	});

	pi.registerCommand("subagents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd);
			ctx.ui.notify(
				`Available subagents:\n\n${formatDetailedAgentList(discovery.agents) || "none"}`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate tasks to subagents with isolated context. Use single mode with agent/task, or parallel mode with tasks. Provide agent to use a named agent like scout, or omit agent in single mode for an ad-hoc isolated pi agent. Use scout for codebase reconnaissance and avoid subagents for tiny local edits.",
		parameters: ToolParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd);
			const availableAgents = formatAgentList(discovery.agents);
			const models = ctx.modelRegistry.getAvailable();
			const hasParallel = params.tasks !== undefined;
			const hasSingleFields =
				params.agent !== undefined ||
				params.task !== undefined ||
				params.cwd !== undefined;

			if (Number(hasParallel) + Number(hasSingleFields) !== 1) {
				const result: SubagentResult = {
					agent: params.agent ?? "adhoc",
					task: params.task ?? "",
					exitCode: 1,
					finalText:
						"Invalid parameters. Provide exactly one mode: single task or parallel tasks.",
					toolCalls: [],
					availableAgents,
				};
				return {
					isError: true,
					content: [{ type: "text", text: result.finalText }],
					details: { mode: "single", results: [result] } as SubagentDetails,
				};
			}

			if (!hasParallel) {
				const { resolved, error } = resolveTask(
					params.agent,
					params.task ?? "",
					params.cwd,
					discovery.agents,
					availableAgents,
					models,
				);
				if (error) {
					return {
						isError: true,
						content: [{ type: "text", text: error.finalText }],
						details: { mode: "single", results: [error] } as SubagentDetails,
					};
				}
				const initial = makePlaceholder(resolved as ResolvedTask);
				onUpdate?.({
					content: [{ type: "text", text: "(starting...)" }],
					details: { mode: "single", results: [initial] } as SubagentDetails,
				});
				const result = await runResolvedTask(
					resolved as ResolvedTask,
					ctx.cwd,
					signal,
					onUpdate
						? (partial) => {
								onUpdate({
									content: [
										{ type: "text", text: partial.finalText || "(running...)" },
									],
									details: {
										mode: "single",
										results: [partial],
									} as SubagentDetails,
								});
							}
						: undefined,
				);
				return {
					isError: isFailed(result),
					content: [{ type: "text", text: singleContent(result) }],
					details: { mode: "single", results: [result] } as SubagentDetails,
				};
			}

			const tasks = params.tasks ?? [];
			if (tasks.length === 0) {
				const text = "Parallel tasks must not be empty.";
				return {
					isError: true,
					content: [{ type: "text", text }],
					details: {
						mode: "parallel",
						results: [
							{
								agent: "parallel",
								task: "",
								exitCode: 1,
								finalText: text,
								toolCalls: [],
							},
						],
					} as SubagentDetails,
				};
			}
			if (tasks.length > MAX_PARALLEL_TASKS) {
				const text = `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`;
				return {
					isError: true,
					content: [{ type: "text", text }],
					details: {
						mode: "parallel",
						results: [
							{
								agent: "parallel",
								task: "",
								exitCode: 1,
								finalText: text,
								toolCalls: [],
							},
						],
					} as SubagentDetails,
				};
			}

			const resolvedTasks: ResolvedTask[] = [];
			const validationErrors: SubagentResult[] = [];
			for (const task of tasks) {
				if (!task.agent.trim()) {
					validationErrors.push({
						agent: "unknown",
						task: task.task.trim(),
						exitCode: 1,
						finalText: "Agent is required for parallel tasks.",
						toolCalls: [],
					});
					continue;
				}
				const { resolved, error } = resolveTask(
					task.agent,
					task.task,
					task.cwd,
					discovery.agents,
					availableAgents,
					models,
				);
				if (error) validationErrors.push(error);
				if (resolved) resolvedTasks.push(resolved);
			}
			if (validationErrors.length > 0) {
				return {
					isError: true,
					content: [{ type: "text", text: validationErrors[0].finalText }],
					details: {
						mode: "parallel",
						results: validationErrors,
					} as SubagentDetails,
				};
			}

			const allResults = resolvedTasks.map(makePlaceholder);
			const emitParallelUpdate = () => {
				onUpdate?.({
					content: [
						{ type: "text", text: `${aggregateStatus(allResults)}...` },
					],
					details: {
						mode: "parallel",
						results: [...allResults],
					} as SubagentDetails,
				});
			};
			emitParallelUpdate();

			const results = await mapWithConcurrencyLimit(
				resolvedTasks,
				MAX_CONCURRENCY,
				signal,
				async (task, index) => {
					const result = await runResolvedTask(
						task,
						ctx.cwd,
						signal,
						(partial) => {
							allResults[index] = partial;
							emitParallelUpdate();
						},
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				},
			);

			const successCount = results.filter((result) => !isFailed(result)).length;
			return {
				isError: successCount === 0,
				content: [{ type: "text", text: parallelContent(results) }],
				details: { mode: "parallel", results } as SubagentDetails,
			};
		},
		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const task of args.tasks.slice(0, 3)) {
					const preview =
						task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
					text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", args.agent || "adhoc") +
				"\n" +
				theme.fg("dim", args.task || "...");
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			const fallbackOutput =
				getText(
					result as { content: Array<{ type: string; text?: string }> },
				) || "(no output)";
			const isError = Boolean((result as { isError?: boolean }).isError);
			if (
				!details ||
				!Array.isArray(details.results) ||
				details.results.length === 0
			) {
				return new Text(
					isError ? theme.fg("error", fallbackOutput) : fallbackOutput,
					0,
					0,
				);
			}

			const renderOne = (
				item: SubagentResult,
				index: number,
				includeTask: boolean,
			) => {
				const output = resultOutput(item);
				const outputLines = output.split("\n");
				const shownOutput = expanded
					? output
					: outputLines.slice(0, 10).join("\n");
				const toolCalls = item.toolCalls ?? [];
				const shownToolCalls = expanded ? toolCalls : toolCalls.slice(-6);
				const failed = isFailed(item);
				const running = item.exitCode === -1 || item.running;
				const icon = running
					? theme.fg("warning", "⏳")
					: failed
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const lines = [
					`${theme.fg("muted", `─── ${index + 1}. `)}${theme.fg("toolTitle", theme.bold(item.agent))} ${icon}${item.agentSource ? theme.fg("muted", ` (${item.agentSource})`) : ""}`,
				];
				if (includeTask) {
					lines.push(theme.fg("muted", "Task:"));
					lines.push(theme.fg("dim", item.task));
				}
				if (shownToolCalls.length > 0) {
					lines.push(theme.fg("muted", `Tool calls (${toolCalls.length}):`));
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
				if (expanded) lines.push(theme.fg("muted", "Output:"));
				lines.push(failed ? theme.fg("error", shownOutput) : shownOutput);
				if (expanded && item.stderr) {
					lines.push(theme.fg("muted", "stderr:"));
					lines.push(theme.fg("error", item.stderr));
				}
				if (expanded && item.malformedJsonLines) {
					lines.push(
						theme.fg(
							"dim",
							`Ignored malformed JSON lines: ${item.malformedJsonLines}`,
						),
					);
				}
				const usage = formatUsage(item.usage, item.model);
				if (usage) lines.push(theme.fg("dim", usage));
				if (
					!expanded &&
					(outputLines.length > 10 || toolCalls.length > shownToolCalls.length)
				)
					lines.push(theme.fg("dim", "(Ctrl+O to expand)"));
				return lines.join("\n");
			};

			if (details.mode === "single") {
				return new Text(renderOne(details.results[0], 0, expanded), 0, 0);
			}

			const running = details.results.filter(
				(item) => item.exitCode === -1,
			).length;
			const failed = details.results.filter(isFailed).length;
			const done = details.results.length - running;
			const icon = running
				? theme.fg("warning", "⏳")
				: failed > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const lines = [
				`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${done}/${details.results.length} done`)}${failed ? theme.fg("warning", `, ${failed} failed`) : ""}${running ? theme.fg("muted", `, ${running} running`) : ""}`,
			];
			for (let i = 0; i < details.results.length; i++) {
				lines.push("");
				lines.push(renderOne(details.results[i], i, expanded));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
