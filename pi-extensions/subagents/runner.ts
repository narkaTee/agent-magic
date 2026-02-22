import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

export interface SubagentToolCall {
	id?: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface RunSubagentOptions {
	cwd: string;
	task: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	onProgress?: (state: {
		text: string;
		toolCalls: SubagentToolCall[];
		model?: string;
		stopReason?: string;
	}) => void;
}

export interface RunSubagentResult {
	exitCode: number;
	stderr: string;
	messages: Message[];
	finalText: string;
	toolCalls: SubagentToolCall[];
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

function extractAssistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function extractAssistantToolCalls(message: Message): SubagentToolCall[] {
	if (message.role !== "assistant") return [];
	const calls: SubagentToolCall[] = [];
	for (const part of message.content) {
		if (part.type !== "toolCall") continue;
		calls.push({
			id: part.id,
			name: part.name,
			arguments:
				typeof part.arguments === "object" && part.arguments !== null
					? (part.arguments as Record<string, unknown>)
					: {},
		});
	}
	return calls;
}

function createPromptFile(
	prompt: string,
): { dir: string; file: string } | undefined {
	if (!prompt.trim()) return undefined;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const file = path.join(dir, "system-prompt.md");
	fs.writeFileSync(file, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, file };
}

export async function runSubagent(
	options: RunSubagentOptions,
): Promise<RunSubagentResult> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0)
		args.push("--tools", options.tools.join(","));

	const promptFile = createPromptFile(options.systemPrompt);
	if (promptFile) args.push("--append-system-prompt", promptFile.file);
	args.push(options.task);

	const messages: Message[] = [];
	const toolCalls: SubagentToolCall[] = [];
	const seenToolCalls = new Set<string>();
	let stderr = "";
	let finalText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let model: string | undefined;
	let aborted = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let settled = false;
			const resolveOnce = (code: number) => {
				if (settled) return;
				settled = true;
				resolve(code);
			};

			let buffer = "";

			const emitProgress = () => {
				options.onProgress?.({
					text: finalText,
					toolCalls: [...toolCalls],
					model,
					stopReason,
				});
			};

			const processLine = (line: string) => {
				const trimmed = line.trim();
				if (!trimmed) return;
				let event: unknown;
				try {
					event = JSON.parse(trimmed);
				} catch {
					return;
				}
				if (!event || typeof event !== "object") return;
				const messageEnd = event as { type?: unknown; message?: unknown };
				if (messageEnd.type !== "message_end" || !messageEnd.message) return;
				const message = messageEnd.message as Message;
				messages.push(message);
				if (message.role !== "assistant") return;

				const messageToolCalls = extractAssistantToolCalls(message);
				let changed = false;
				for (const call of messageToolCalls) {
					const key = call.id
						? call.id
						: `${call.name}:${JSON.stringify(call.arguments)}`;
					if (seenToolCalls.has(key)) continue;
					seenToolCalls.add(key);
					toolCalls.push(call);
					changed = true;
				}

				const text = extractAssistantText(message);
				if (text) {
					finalText = text;
					changed = true;
				}
				if (message.stopReason) {
					stopReason = message.stopReason;
					changed = true;
				}
				if (message.errorMessage) errorMessage = message.errorMessage;
				if (message.model) model = message.model;
				if (changed) emitProgress();
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolveOnce(code ?? 0);
			});

			proc.on("error", (error) => {
				errorMessage = error.message;
				stderr += `${error.name}: ${error.message}`;
				resolveOnce(1);
			});

			if (options.signal) {
				const kill = () => {
					aborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 2000);
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});

		if (aborted) {
			throw new Error("Subagent aborted");
		}

		return {
			exitCode,
			stderr,
			messages,
			finalText,
			toolCalls,
			stopReason,
			errorMessage,
			model,
		};
	} finally {
		if (promptFile) {
			try {
				fs.unlinkSync(promptFile.file);
			} catch {}
			try {
				fs.rmdirSync(promptFile.dir);
			} catch {}
		}
	}
}
