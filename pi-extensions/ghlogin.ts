import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WRAPPER_RELATIVE_PATH = path.join("skills", "github", "gh-app-auth");
const AUTH_FILE = path.join(os.homedir(), ".config", "gh", "wrapper-auth.json");
const WAIT_TIMEOUT_SECONDS = "900";
const AUTH_REQUIRED_EXIT_CODE = 42;

function trimOutput(result: ExecResult): string {
	const text = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
	return text || `exit code ${result.code}`;
}

function parseAuthPrompt(text: string): { instruction: string; url: string; code: string } | undefined {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length < 3) return undefined;
	return { instruction: lines[0], url: lines[1], code: lines[2] };
}

function findWrapper(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, WRAPPER_RELATIVE_PATH);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const fallback = path.resolve(extensionDir, "..", WRAPPER_RELATIVE_PATH);
	if (fs.existsSync(fallback)) return fallback;
	return undefined;
}

function readAccessToken(): string | undefined {
	try {
		const json = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as { access_token?: string };
		if (typeof json.access_token === "string" && json.access_token.length > 0) {
			return json.access_token;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

type EnsureAuthResult =
	| { kind: "ready" }
	| { kind: "auth-required"; prompt: { instruction: string; url: string; code: string } }
	| { kind: "error"; error: string };

async function ensureWrapperAuth(pi: ExtensionAPI, wrapperPath: string, cwd: string): Promise<EnsureAuthResult> {
	const initial = await pi.exec(wrapperPath, ["auth", "status"], { cwd });

	if (initial.code === 0) {
		return { kind: "ready" };
	}

	if (initial.code !== AUTH_REQUIRED_EXIT_CODE) {
		return { kind: "error", error: `gh-app-auth failed: ${trimOutput(initial)}` };
	}

	const prompt = parseAuthPrompt(initial.stderr);
	if (!prompt) {
		return { kind: "error", error: `gh-app-auth requested auth but output was unexpected: ${trimOutput(initial)}` };
	}

	return { kind: "auth-required", prompt };
}

async function waitForWrapperAuth(pi: ExtensionAPI, wrapperPath: string, cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const waited = await pi.exec(wrapperPath, ["--wait-for-auth", "--timeout", WAIT_TIMEOUT_SECONDS, "auth", "status"], {
		cwd,
	});
	if (waited.code !== 0) {
		return { ok: false, error: `Waiting for GitHub auth failed: ${trimOutput(waited)}` };
	}
	return { ok: true };
}

async function loginGhWithToken(pi: ExtensionAPI, cwd: string, token: string): Promise<ExecResult> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ghlogin-"));
	const tokenFile = path.join(tmpDir, "token");
	fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	try {
		return await pi.exec("bash", ["-c", "gh auth login --hostname github.com --with-token < \"$0\"", tokenFile], { cwd });
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ghlogin", {
		description: "Authenticate GitHub CLI via gh-app-auth token sync",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("ghlogin requires interactive mode", "error");
				return;
			}

			const wrapperPath = findWrapper(ctx.cwd);
			if (!wrapperPath) {
				ctx.ui.notify("Could not find skills/github/gh-app-auth", "error");
				return;
			}

			const authResult = await ensureWrapperAuth(pi, wrapperPath, ctx.cwd);
			if (authResult.kind === "error") {
				ctx.ui.notify(authResult.error, "error");
				return;
			}

			if (authResult.kind === "auth-required") {
				ctx.ui.notify(`${authResult.prompt.instruction}\n${authResult.prompt.url}\n${authResult.prompt.code}`, "info");
				const waited = await waitForWrapperAuth(pi, wrapperPath, ctx.cwd);
				if (!waited.ok) {
					ctx.ui.notify(waited.error, "error");
					return;
				}
			}

			const token = readAccessToken();
			if (!token) {
				ctx.ui.notify(`No access_token found in ${AUTH_FILE}`, "error");
				return;
			}

			const login = await loginGhWithToken(pi, ctx.cwd, token);
			if (login.code !== 0) {
				ctx.ui.notify(`gh auth login failed: ${trimOutput(login)}`, "error");
				return;
			}

			const status = await pi.exec("gh", ["auth", "status", "--hostname", "github.com"], { cwd: ctx.cwd });
			if (status.code !== 0) {
				ctx.ui.notify(`gh login completed, but status check failed: ${trimOutput(status)}`, "warning");
				return;
			}

			ctx.ui.notify("GitHub CLI is authenticated for github.com", "info");
		},
	});
}
