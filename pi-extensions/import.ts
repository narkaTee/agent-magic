import fs from "node:fs";
import path from "node:path";
import { BorderedLoader, type ExecResult, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

type GistFile = {
	filename?: string;
	raw_url?: string;
	content?: string;
	truncated?: boolean;
};

type Gist = {
	id: string;
	description?: string | null;
	created_at?: string;
	updated_at?: string;
	files?: Record<string, GistFile>;
};

type SessionExportData = {
	header?: Record<string, unknown>;
	entries?: unknown[];
};

function trimOutput(result: ExecResult): string {
	const text = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
	return text || `exit code ${result.code}`;
}

function isLikelyGistId(value: string): boolean {
	return /^[0-9a-f]{8,}$/i.test(value);
}

function extractGistId(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	if (isLikelyGistId(value)) return value;

	try {
		const url = new URL(value);

		const hash = url.hash.replace(/^#/, "").trim();
		if (hash && isLikelyGistId(hash)) return hash;

		if (url.hostname === "gist.github.com") {
			const parts = url.pathname
				.split("/")
				.map((p) => p.trim())
				.filter(Boolean);
			const last = parts.at(-1)?.replace(/\.git$/i, "");
			if (last && isLikelyGistId(last)) return last;
		}

		const parts = url.pathname
			.split("/")
			.map((p) => p.trim())
			.filter(Boolean)
			.reverse();
		for (const part of parts) {
			if (isLikelyGistId(part)) return part;
		}
	} catch {
	}

	const matches = value.match(/[0-9a-f]{8,}/gi);
	if (!matches || matches.length === 0) return undefined;
	return matches[matches.length - 1];
}

function formatDate(value?: string): string {
	if (!value) return "unknown date";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function buildSessionJsonl(html: string): string {
	const match = html.match(/<script[^>]*id=["']session-data["'][^>]*>([\s\S]*?)<\/script>/i);
	if (!match) {
		throw new Error("session-data block not found in session.html");
	}

	const base64 = match[1].trim();
	if (!base64) {
		throw new Error("session-data block is empty");
	}

	let parsed: SessionExportData;
	try {
		const json = Buffer.from(base64, "base64").toString("utf8");
		parsed = JSON.parse(json) as SessionExportData;
	} catch {
		throw new Error("failed to decode session-data from HTML");
	}

	if (!parsed.header || !Array.isArray(parsed.entries)) {
		throw new Error("session-data is missing header or entries");
	}

	const lines: string[] = [];
	lines.push(JSON.stringify({ type: "header", ...parsed.header }));
	for (const entry of parsed.entries) {
		lines.push(JSON.stringify(entry));
	}
	return `${lines.join("\n")}\n`;
}

function makeOutputPath(currentSessionFile: string | undefined, cwd: string, gistId: string): string {
	const targetDir = currentSessionFile ? path.dirname(currentSessionFile) : cwd;
	fs.mkdirSync(targetDir, { recursive: true });

	const baseName = `imported-${gistId}`;
	const first = path.join(targetDir, `${baseName}.jsonl`);
	if (!fs.existsSync(first)) return first;

	for (let i = 1; i < 1000; i++) {
		const candidate = path.join(targetDir, `${baseName}-${i}.jsonl`);
		if (!fs.existsSync(candidate)) return candidate;
	}

	return path.join(targetDir, `${baseName}-${Date.now()}.jsonl`);
}

async function ensureGhReady(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const version = await pi.exec("gh", ["--version"], { cwd });
	if (version.code !== 0) {
		return `GitHub CLI (gh) not found: ${trimOutput(version)}`;
	}

	const auth = await pi.exec("gh", ["auth", "status", "--hostname", "github.com"], { cwd });
	if (auth.code !== 0) {
		return "GitHub CLI is not logged in. Run /ghlogin (or gh auth login).";
	}

	return undefined;
}

async function listSessionGists(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<Gist[]> {
	let result = await pi.exec("gh", ["api", "--paginate", "--slurp", "/gists?per_page=100"], { cwd, signal });
	if (result.code !== 0) {
		result = await pi.exec("gh", ["api", "/gists?per_page=100"], { cwd, signal });
		if (result.code !== 0) {
			throw new Error(`Failed to list gists: ${trimOutput(result)}`);
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout || "[]");
	} catch {
		throw new Error("Failed to parse gist list from gh output");
	}

	let gists: Gist[] = [];
	if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
		gists = (parsed as Gist[][]).flat();
	} else if (Array.isArray(parsed)) {
		gists = parsed as Gist[];
	}

	return gists
		.filter((gist) => {
			const files = gist.files ? Object.values(gist.files) : [];
			return files.some((file) => file.filename === "session.html");
		})
		.sort((a, b) => {
			const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
			const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
			return bTime - aTime;
		});
}

async function downloadSessionHtmlFromGist(pi: ExtensionAPI, cwd: string, gistId: string): Promise<string> {
	const gistResult = await pi.exec("gh", ["api", `/gists/${gistId}`], { cwd });
	if (gistResult.code !== 0) {
		throw new Error(`Failed to load gist ${gistId}: ${trimOutput(gistResult)}`);
	}

	let gist: Gist;
	try {
		gist = JSON.parse(gistResult.stdout || "{}") as Gist;
	} catch {
		throw new Error("Failed to parse gist JSON");
	}

	const files = gist.files ? Object.values(gist.files) : [];
	const sessionFile = files.find((file) => file.filename === "session.html");
	if (!sessionFile) {
		throw new Error(`Gist ${gistId} does not contain session.html`);
	}

	if (sessionFile.content && !sessionFile.truncated) {
		return sessionFile.content;
	}

	if (!sessionFile.raw_url) {
		throw new Error(`session.html missing raw_url in gist ${gistId}`);
	}

	const response = await fetch(sessionFile.raw_url, {
		headers: {
			"User-Agent": "pi-import-extension/1.0",
		},
	});
	if (!response.ok) {
		throw new Error(`Failed to download session.html: HTTP ${response.status}`);
	}
	return await response.text();
}

async function deleteGist(pi: ExtensionAPI, cwd: string, gistId: string, signal?: AbortSignal): Promise<void> {
	const result = await pi.exec("gh", ["api", "-X", "DELETE", `/gists/${gistId}`], { cwd, signal });
	if (result.code !== 0) {
		throw new Error(`Failed to delete gist ${gistId}: ${trimOutput(result)}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("import", {
		description: "Import a shared session from a GitHub gist",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/import requires interactive mode", "error");
				return;
			}

			const ghError = await ensureGhReady(pi, ctx.cwd);
			if (ghError) {
				ctx.ui.notify(ghError, "error");
				return;
			}

			let gistId: string | undefined;
			const trimmed = args.trim();

			if (!trimmed) {
				const listResult = await ctx.ui.custom<
					| { ok: true; gists: Gist[] }
					| { ok: false; cancelled: true }
					| { ok: false; cancelled?: false; error: string }
				>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "Loading session gists...");
					const controller = new AbortController();
					let finished = false;

					const finish = (
						result:
							| { ok: true; gists: Gist[] }
							| { ok: false; cancelled: true }
							| { ok: false; cancelled?: false; error: string },
					) => {
						if (finished) return;
						finished = true;
						done(result);
					};

					loader.onAbort = () => {
						controller.abort();
						finish({ ok: false, cancelled: true });
					};

					listSessionGists(pi, ctx.cwd, controller.signal)
						.then((gists) => finish({ ok: true, gists }))
						.catch((error) => {
							if (controller.signal.aborted) {
								finish({ ok: false, cancelled: true });
								return;
							}
							finish({
								ok: false,
								error: error instanceof Error ? error.message : "Failed to list gists",
							});
						});

					return loader;
				});

				if (!listResult.ok) {
					if (!listResult.cancelled) {
						ctx.ui.notify(listResult.error, "error");
					} else {
						ctx.ui.notify("Import cancelled", "info");
					}
					return;
				}

				const gists = listResult.gists;
				if (gists.length === 0) {
					ctx.ui.notify("No session.html gists found", "info");
					return;
				}

				const options = gists.map((gist) => {
					const description = gist.description?.trim() || "";
					const descriptionSuffix = description ? ` · ${description}` : "";
					return `${gist.id} · ${formatDate(gist.updated_at || gist.created_at)}${descriptionSuffix}`;
				});

				const selected = await ctx.ui.select("Import shared session from gist", options);
				if (!selected) {
					ctx.ui.notify("Import cancelled", "info");
					return;
				}

				gistId = selected.split(" · ")[0]?.trim();
			} else {
				gistId = extractGistId(trimmed);
			}

			if (!gistId) {
				ctx.ui.notify("Could not extract gist ID. Use /import <gist-id-or-url>", "error");
				return;
			}

			let html: string;
			try {
				html = await downloadSessionHtmlFromGist(pi, ctx.cwd, gistId);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Failed to download session", "error");
				return;
			}

			let jsonl: string;
			try {
				jsonl = buildSessionJsonl(html);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Failed to extract session", "error");
				return;
			}

			const outputPath = makeOutputPath(ctx.sessionManager.getSessionFile(), ctx.cwd, gistId);
			try {
				fs.writeFileSync(outputPath, jsonl, "utf8");
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? `Failed to write session file: ${error.message}` : "Failed to write session file",
					"error",
				);
				return;
			}

			const deleteChoice = await ctx.ui.select(`Imported to ${outputPath}\nDelete gist ${gistId}?`, ["No", "Yes"]);
			if (deleteChoice === "Yes") {
				const deletion = await ctx.ui.custom<
					| { ok: true }
					| { ok: false; cancelled: true }
					| { ok: false; cancelled?: false; error: string }
				>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `Deleting gist ${gistId}...`);
					const controller = new AbortController();
					let finished = false;

					const finish = (
						result:
							| { ok: true }
							| { ok: false; cancelled: true }
							| { ok: false; cancelled?: false; error: string },
					) => {
						if (finished) return;
						finished = true;
						done(result);
					};

					loader.onAbort = () => {
						controller.abort();
						finish({ ok: false, cancelled: true });
					};

					deleteGist(pi, ctx.cwd, gistId, controller.signal)
						.then(() => finish({ ok: true }))
						.catch((error) => {
							if (controller.signal.aborted) {
								finish({ ok: false, cancelled: true });
								return;
							}
							finish({
								ok: false,
								error: error instanceof Error ? error.message : "Failed to delete gist",
							});
						});

					return loader;
				});

				if (deletion.ok) {
					ctx.ui.notify(`Deleted gist ${gistId}`, "info");
				} else if (!deletion.cancelled) {
					let acknowledged = false;
					while (!acknowledged) {
						const ack = await ctx.ui.select(
							`Failed to delete gist ${gistId}.\n${deletion.error}\nPlease delete it manually.`,
							["OK"],
						);
						acknowledged = ack === "OK";
					}
				}
			}

			const switched = await ctx.switchSession(outputPath);
			if (switched.cancelled) {
				ctx.ui.notify(`Imported session at ${outputPath}`, "info");
				return;
			}

			ctx.ui.notify(`Imported and opened session from gist ${gistId}`, "info");
		},
	});
}
