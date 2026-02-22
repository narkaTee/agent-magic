/**
 * Tool Overrides extension.
 *
 * This extension takes ownership of the built-in `read`, `write`, `edit`, and `bash` tools.
 * By default it preserves normal host behavior, but when Gondolin is enabled (via `--gondolin`
 * or `/gondolin on`) the same tool names are transparently routed through a Gondolin VM.
 *
 * It also customizes TUI rendering for `read` and `write` so calls/results are easier to scan
 * (shortened paths, line counts, range hints), while keeping tool names unchanged for the model.
 *
 * In short: same tool interface for the agent, optional sandboxed execution backend for users.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createHttpHooks,
	RealFSProvider,
	ShadowProvider,
	VM,
} from "@earendil-works/gondolin";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	ReadOperations,
	WriteOperations,
} from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const GUEST_WORKSPACE = "/workspace";
const WRAPPED_TOOL_NAMES = new Set(["read", "write", "edit", "bash"]);
const GONDOLIN_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"gondolin.json",
);

function shortenPath(inputPath: string): string {
	const home = os.homedir();
	if (inputPath.startsWith(home)) return `~${inputPath.slice(home.length)}`;
	return inputPath;
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function countContentLines(content: string): number {
	if (!content) return 0;
	return content.split("\n").length;
}

function countReadLines(result: {
	content: Array<{ type: string; text?: string }>;
	details?: { truncation?: { outputLines?: unknown } };
}): number {
	const truncatedLines = result.details?.truncation?.outputLines;
	if (typeof truncatedLines === "number") return truncatedLines;

	let text = result.content
		.filter((chunk) => chunk.type === "text")
		.map((chunk) => chunk.text ?? "")
		.join("\n")
		.replace(/\r\n/g, "\n")
		.trimEnd();

	if (!text) return 0;
	if (text.startsWith("Read image file")) return 0;
	if (/^\[Line \d+ is .*Use bash:/.test(text)) return 0;

	text = text.replace(/\n\n\[[^\]]*Use offset=\d+[^\]]*\]\s*$/m, "").trimEnd();
	if (!text) return 0;

	return text.split("\n").length;
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function toGuestPath(localCwd: string, localPath: string): string {
	const rel = path.relative(localCwd, localPath);
	if (rel === "") return GUEST_WORKSPACE;
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`path escapes workspace: ${localPath}`);
	}
	const posixRel = rel.split(path.sep).join(path.posix.sep);
	return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function shouldShadowWorkspacePath(inputPath: string): boolean {
	const normalized = path.posix.normalize(inputPath);
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return false;
	const base = parts[parts.length - 1];
	if (base === ".env" || base.startsWith(".env.") || base === ".npmrc")
		return true;
	if (parts.includes(".aws")) return true;
	return false;
}

function createWorkspaceProvider(localCwd: string) {
	return new ShadowProvider(new RealFSProvider(localCwd), {
		shouldShadow: ({ path: providerPath }) =>
			shouldShadowWorkspacePath(providerPath),
		writeMode: "deny",
	});
}

function createSecretHooks(ctx?: ExtensionContext) {
	const githubToken = process.env.GITHUB_TOKEN?.trim();
	const configuredSecrets = githubToken ? ["GITHUB_TOKEN@api.github.com"] : [];
	ctx?.ui.notify(
		`Gondolin secrets configured: ${configuredSecrets.length > 0 ? configuredSecrets.join(",") : "none"}`,
		"info",
	);
	return createHttpHooks({
		allowedHosts: ["*"],
		blockInternalRanges: true,
		replaceSecretsInQuery: false,
		secrets: githubToken
			? {
					GITHUB_TOKEN: {
						hosts: ["api.github.com"],
						value: githubToken,
					},
				}
			: undefined,
	});
}

function loadConfiguredGondolinEnabled(): boolean {
	try {
		if (!fs.existsSync(GONDOLIN_CONFIG_PATH)) return false;
		const raw = fs.readFileSync(GONDOLIN_CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as { enabled?: unknown };
		return parsed.enabled === true;
	} catch {
		return false;
	}
}

function saveConfiguredGondolinEnabled(enabled: boolean): void {
	const dir = path.dirname(GONDOLIN_CONFIG_PATH);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		GONDOLIN_CONFIG_PATH,
		`${JSON.stringify({ enabled }, null, 2)}\n`,
		"utf8",
	);
}

async function createVm(localCwd: string, ctx?: ExtensionContext) {
	const { httpHooks, env } = createSecretHooks(ctx);
	return VM.create({
		httpHooks,
		env,
		vfs: {
			mounts: {
				[GUEST_WORKSPACE]: createWorkspaceProvider(localCwd),
			},
		},
	});
}

async function closeVm(vm: VM | null): Promise<void> {
	if (!vm) return;
	try {
		await vm.close();
	} catch {}
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (p) => {
			const guestPath = toGuestPath(localCwd, p);
			return await vm.readFile(guestPath);
		},
		access: async (p) => {
			const guestPath = toGuestPath(localCwd, p);
			const r = await vm.exec([
				"/bin/sh",
				"-lc",
				`test -r ${shQuote(guestPath)}`,
			]);
			if (!r.ok) throw new Error(`not readable: ${p}`);
		},
		detectImageMimeType: async (p) => {
			const guestPath = toGuestPath(localCwd, p);
			const r = await vm.exec([
				"/bin/sh",
				"-lc",
				`if command -v file >/dev/null 2>&1; then file --mime-type -b ${shQuote(guestPath)}; fi`,
			]);
			if (!r.ok) return null;
			const mime = r.stdout.trim();
			return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
				mime,
			)
				? mime
				: null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const guestPath = toGuestPath(localCwd, p);
			await vm.writeFile(guestPath, content);
		},
		mkdir: async (dir) => {
			const guestDir = toGuestPath(localCwd, dir);
			const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
			if (!r.ok) throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		access: readOps.access,
		writeFile: writeOps.writeFile,
	};
}

function createGondolinBashOps(
	localCwd: string,
	ensureVm: (ctx?: ExtensionContext) => Promise<VM>,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const vm = await ensureVm();
			const guestCwd = toGuestPath(localCwd, cwd);
			const ac = new AbortController();
			const onAbort = () => ac.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							ac.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec(["/bin/bash", "-lc", command], {
					cwd: guestCwd,
					signal: ac.signal,
					stdout: "pipe",
					stderr: "pipe",
				});

				for await (const chunk of proc.output()) {
					onData(chunk.data);
				}

				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (err) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw err;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("gondolin", {
		description: "Enable Gondolin sandbox tool wrapping",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let vm: VM | null = null;
	let vmStarting: Promise<VM> | null = null;
	let vmStartEpoch = 0;

	const ensureVm = async (ctx?: ExtensionContext): Promise<VM> => {
		if (!sandboxEnabled) throw new Error("Gondolin sandbox is disabled");
		if (vm) return vm;
		if (vmStarting) return vmStarting;

		const startEpoch = ++vmStartEpoch;
		const starting = (async () => {
			const created = await createVm(localCwd, ctx);
			if (!sandboxEnabled || startEpoch !== vmStartEpoch) {
				await closeVm(created);
				throw new Error("Gondolin sandbox startup cancelled");
			}
			vm = created;
			return created;
		})();
		vmStarting = starting;

		try {
			const started = await starting;
			if (vmStarting === starting) vmStarting = null;
			return started;
		} catch (err) {
			if (vmStarting === starting) vmStarting = null;
			if (!vmStarting) vm = null;
			throw err;
		}
	};

	const bashOps = createGondolinBashOps(localCwd, ensureVm);

	const setReadyStatus = (ctx: ExtensionContext) => {
		const allToolNames = pi.getAllTools().map((tool) => tool.name);
		const wrapped = allToolNames.filter((name) => WRAPPED_TOOL_NAMES.has(name));
		const unwrapped = allToolNames.filter(
			(name) => !WRAPPED_TOOL_NAMES.has(name),
		);
		const wrappedText = wrapped.length > 0 ? wrapped.join(",") : "none";
		const unwrappedText = unwrapped.length > 0 ? unwrapped.join(",") : "none";
		ctx.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg(
				"accent",
				`Gondolin ready · wrapped:${wrappedText} · native:${unwrappedText}`,
			),
		);
	};

	const disableSandbox = async (ctx: ExtensionContext) => {
		sandboxEnabled = false;
		vmStartEpoch++;
		const activeVm = vm;
		const starting = vmStarting;
		vm = null;
		vmStarting = null;
		await closeVm(activeVm);
		if (starting) {
			try {
				const startedVm = await starting;
				if (startedVm !== activeVm) await closeVm(startedVm);
			} catch {}
		}
		ctx.ui.setStatus("gondolin", undefined);
	};

	const enableSandbox = async (ctx: ExtensionContext) => {
		sandboxEnabled = true;
		try {
			await ensureVm(ctx);
			setReadyStatus(ctx);
		} catch (err) {
			sandboxEnabled = false;
			await closeVm(vm);
			vm = null;
			vmStarting = null;
			const reason = err instanceof Error ? err.message : String(err);
			ctx.ui.setStatus(
				"gondolin",
				ctx.ui.theme.fg("muted", `Gondolin unavailable (${reason})`),
			);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const enabledFromFlag = Boolean(pi.getFlag("gondolin"));
		sandboxEnabled = enabledFromFlag || loadConfiguredGondolinEnabled();
		if (!sandboxEnabled) {
			await disableSandbox(ctx);
			return;
		}
		await enableSandbox(ctx);
	});

	pi.registerCommand("gondolin", {
		description: "Toggle Gondolin sandbox setting (on/off/toggle/status)",
		handler: async (args, ctx) => {
			const parts = args
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter((part) => part.length > 0);
			let value = (parts[0] ?? "").replace(/^\//, "");
			if (value === "gondolin") value = (parts[1] ?? "").replace(/^\//, "");
			if (value === "status") {
				ctx.ui.notify(`Gondolin: ${sandboxEnabled ? "on" : "off"}`, "info");
				return;
			}

			let next = sandboxEnabled;
			if (value === "" || value === "toggle") next = !sandboxEnabled;
			else if (["on", "enable", "enabled", "true", "1"].includes(value))
				next = true;
			else if (["off", "disable", "disabled", "false", "0"].includes(value))
				next = false;
			else {
				ctx.ui.notify("Usage: /gondolin [on|off|toggle|status]", "info");
				return;
			}

			saveConfiguredGondolinEnabled(next);
			if (next) {
				await enableSandbox(ctx);
			} else {
				await disableSandbox(ctx);
			}
			ctx.ui.notify(`Gondolin ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!vm && !vmStarting) return;
		ctx.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("muted", "Gondolin: stopping"),
		);
		if (vm) {
			await closeVm(vm);
		} else if (vmStarting) {
			try {
				const startedVm = await vmStarting;
				await closeVm(startedVm);
			} catch {}
		}
		vm = null;
		vmStarting = null;
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!sandboxEnabled)
				return localRead.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(localCwd, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const readArgs = args as {
				path?: unknown;
				file_path?: unknown;
				offset?: number;
				limit?: number;
			};
			const rawPath = str(readArgs.file_path ?? readArgs.path);
			const resolvedPath = rawPath !== null ? shortenPath(rawPath) : null;
			const offset = readArgs.offset;
			const limit = readArgs.limit;
			const invalidArg = theme.fg("error", "[invalid arg]");
			let pathDisplay =
				resolvedPath === null
					? invalidArg
					: resolvedPath
						? theme.fg("accent", resolvedPath)
						: theme.fg("toolOutput", "...");
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const lines = countReadLines(
				result as {
					content: Array<{ type: string; text?: string }>;
					details?: { truncation?: { outputLines?: unknown } };
				},
			);
			const label = lines === 1 ? "1 line read" : `${lines} lines read`;
			return new Text(theme.fg("muted", label), 0, 0);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!sandboxEnabled)
				return localWrite.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(localCwd, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const writeArgs = args as {
				path?: unknown;
				file_path?: unknown;
				content?: unknown;
			};
			const rawPath = str(writeArgs.file_path ?? writeArgs.path);
			const resolvedPath = rawPath !== null ? shortenPath(rawPath) : null;
			const fileContent = str(writeArgs.content);
			const invalidArg = theme.fg("error", "[invalid arg]");
			const lineOne =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(resolvedPath === null
					? invalidArg
					: resolvedPath
						? theme.fg("accent", resolvedPath)
						: theme.fg("toolOutput", "..."));
			const lines = fileContent === null ? 0 : countContentLines(fileContent);
			const label = lines === 1 ? "1 line" : `${lines} lines`;
			return new Text(`${lineOne}\n${theme.fg("muted", label)}`, 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!sandboxEnabled)
				return localEdit.execute(id, params, signal, onUpdate);
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(localCwd, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate) {
			if (!sandboxEnabled)
				return localBash.execute(id, params, signal, onUpdate);
			const tool = createBashTool(localCwd, { operations: bashOps });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled) return;
		return { operations: bashOps };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!sandboxEnabled) return;
		try {
			await ensureVm(ctx);
		} catch {
			sandboxEnabled = false;
			ctx.ui.setStatus(
				"gondolin",
				ctx.ui.theme.fg("muted", "Gondolin unavailable (fallback host)"),
			);
			return;
		}
		const systemPrompt = event.systemPrompt.replace(
			`Current working directory: ${localCwd}`,
			`Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
		);
		return { systemPrompt };
	});
}
