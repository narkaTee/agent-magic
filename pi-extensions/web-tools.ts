import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Readability } from "@mozilla/readability";
import { Type } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 10;
const DEFAULT_FETCH_TIMEOUT_MS = 20000;

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 20,
			description: "Number of results (1-20, default 10)",
		}),
	),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "Result offset for pagination" }),
	),
	country: Type.Optional(
		Type.String({ description: "Country code (e.g. US, DE, JP)" }),
	),
	search_lang: Type.Optional(
		Type.String({ description: "Search language code (e.g. en, de, fr)" }),
	),
	safesearch: Type.Optional(
		Type.String({ description: "Safe search mode: off, moderate, strict" }),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 120000,
			description: "Request timeout in milliseconds (default 20000)",
		}),
	),
	max_chars: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 200000,
			description: "Maximum markdown characters before final truncation",
		}),
	),
});

type SearchResultItem = {
	title: string;
	url: string;
	description: string;
	age?: string;
	extra_snippets?: string[];
};

type WebSearchDetails = {
	query: string;
	count: number;
	offset: number;
	results: SearchResultItem[];
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

type WebFetchDetails = {
	url: string;
	finalUrl: string;
	title: string;
	siteName?: string;
	byline?: string;
	excerpt?: string;
	language?: string;
	contentType?: string;
	contentLength?: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

function mergeSignals(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function withTruncationNotice(
	output: string,
	prefix: string,
): {
	text: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
} {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content };
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-web-tool-"));
	const fullOutputPath = join(dir, `${prefix}.txt`);
	writeFileSync(fullOutputPath, output, "utf8");
	let text = truncation.content;
	text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	text += ` Full output saved to: ${fullOutputPath}]`;
	return { text, truncation, fullOutputPath };
}

function formatSearchMarkdown(
	query: string,
	count: number,
	offset: number,
	results: SearchResultItem[],
): string {
	const lines: string[] = [
		`# Web search results`,
		`Query: ${query}`,
		`Requested count: ${count}`,
		`Offset: ${offset}`,
		`Returned: ${results.length}`,
		"",
	];
	if (results.length === 0) {
		lines.push("No results.");
		return lines.join("\n");
	}
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const title = result.title || result.url || "(untitled)";
		lines.push(`${i + 1}. ${title}`);
		if (result.url) {
			lines.push(`   URL: ${result.url}`);
		}
		if (result.age) {
			lines.push(`   Age: ${result.age}`);
		}
		if (result.description) lines.push(`   Description: ${result.description}`);
		const snippets =
			result.extra_snippets
				?.filter((snippet) => snippet.trim().length > 0)
				.slice(0, 2) ?? [];
		if (snippets.length > 0) {
			lines.push("Snippets:");
		}
		for (const snippet of snippets) {
			lines.push(`   - ${snippet}`);
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

function normalizeFetchUrl(url: URL): URL {
	if (url.hostname !== "github.com") return url;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 5 || parts[2] !== "blob") return url;
	const owner = parts[0];
	const repo = parts[1];
	const rest = parts.slice(3).join("/");
	return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest}`);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Brave Search API and return a concise LLM-friendly result set. Requires BRAVE_SEARCH_API_KEY in environment.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate) {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
			if (!apiKey) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Missing BRAVE_SEARCH_API_KEY environment variable.",
						},
					],
					details: {},
				};
			}
			const count = params.count ?? DEFAULT_SEARCH_COUNT;
			const offset = params.offset ?? 0;
			const query = new URLSearchParams({
				q: params.query,
				count: String(count),
				offset: String(offset),
				result_filter: "web",
			});
			if (params.country) query.set("country", params.country);
			if (params.search_lang) query.set("search_lang", params.search_lang);
			if (params.safesearch) query.set("safesearch", params.safesearch);
			const { signal: requestSignal, cleanup } = mergeSignals(signal, 20000);
			let response: Response;
			try {
				response = await fetch(`${BRAVE_SEARCH_ENDPOINT}?${query.toString()}`, {
					method: "GET",
					headers: {
						Accept: "application/json",
						"X-Subscription-Token": apiKey,
					},
					signal: requestSignal,
				});
			} finally {
				cleanup();
			}
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Brave API error ${response.status}: ${body || response.statusText}`,
						},
					],
					details: {},
				};
			}
			const json = (await response.json()) as {
				web?: {
					results?: Array<{
						title?: string;
						url?: string;
						description?: string;
						age?: string;
						language?: string;
						extra_snippets?: string[];
					}>;
				};
			};
			const results = (json.web?.results ?? []).map((result) => ({
				title: result.title ?? "",
				url: result.url ?? "",
				description: result.description ?? "",
				age: result.age,
				extra_snippets: result.extra_snippets,
			}));
			const details: WebSearchDetails = {
				query: params.query,
				count,
				offset,
				results,
			};
			const output = formatSearchMarkdown(params.query, count, offset, results);
			const truncated = withTruncationNotice(output, "web-search");
			details.truncation = truncated.truncation;
			details.fullOutputPath = truncated.fullOutputPath;
			return {
				content: [{ type: "text", text: truncated.text }],
				details,
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) +
					theme.fg("muted", String(args.query ?? "")),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const isError = Boolean((result as { isError?: boolean }).isError);
			if (isError) {
				const text = result.content[0];
				return new Text(
					theme.fg(
						"error",
						text?.type === "text" ? text.text : "web_search failed",
					),
					0,
					0,
				);
			}
			const details = result.details as Partial<WebSearchDetails> | undefined;
			if (!details?.query || !details.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const maxUrls = expanded ? details.results.length : 8;
			const urls = details.results
				.map((item) => item.url)
				.filter((url) => typeof url === "string" && url.length > 0)
				.slice(0, maxUrls);
			const lines: string[] = [
				theme.fg("muted", `Results: ${details.results.length}`),
			];
			for (const url of urls) {
				lines.push(theme.fg("dim", `- ${url}`));
			}
			if (!expanded && details.results.length > urls.length) {
				lines.push(
					theme.fg("dim", `... ${details.results.length - urls.length} more`),
				);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL, extract main article content with Mozilla Readability, and convert to markdown with Turndown.",
		parameters: WebFetchParams,
		async execute(_toolCallId, params, signal, _onUpdate) {
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(params.url);
			} catch {
				return {
					isError: true,
					content: [{ type: "text", text: `Invalid URL: ${params.url}` }],
					details: {},
				};
			}
			if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Unsupported protocol: ${parsedUrl.protocol}`,
						},
					],
					details: {},
				};
			}
			const requestUrl = normalizeFetchUrl(parsedUrl);
			const timeoutMs = params.timeout_ms ?? DEFAULT_FETCH_TIMEOUT_MS;
			const { signal: requestSignal, cleanup } = mergeSignals(
				signal,
				timeoutMs,
			);
			let response: Response;
			try {
				response = await fetch(requestUrl.toString(), {
					method: "GET",
					redirect: "follow",
					headers: {
						"User-Agent": "pi-web-tool/1.0",
						Accept:
							"text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
					},
					signal: requestSignal,
				});
			} finally {
				cleanup();
			}
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Fetch failed with status ${response.status}: ${body || response.statusText}`,
						},
					],
					details: {},
				};
			}
			const contentType = response.headers.get("content-type") ?? "";
			const body = await response.text();
			const finalUrl = response.url || requestUrl.toString();
			const contentLength = body.length;
			let title = "";
			let byline: string | undefined;
			let siteName: string | undefined;
			let excerpt: string | undefined;
			let language: string | undefined;
			let markdown = "";

			if (
				contentType.includes("text/html") ||
				contentType.includes("application/xhtml+xml") ||
				body.includes("<html")
			) {
				const dom = new JSDOM(body, { url: finalUrl });
				language = dom.window.document.documentElement.lang || undefined;
				const article = new Readability(dom.window.document).parse();
				title = article?.title ?? dom.window.document.title ?? finalUrl;
				byline = article?.byline ?? undefined;
				siteName = article?.siteName ?? undefined;
				excerpt = article?.excerpt ?? undefined;
				const contentHtml =
					article?.content ?? dom.window.document.body?.innerHTML ?? "";
				const turndown = new TurndownService({
					headingStyle: "atx",
					codeBlockStyle: "fenced",
				});
				markdown = turndown
					.turndown(contentHtml)
					.replace(/\n{3,}/g, "\n\n")
					.trim();
			} else {
				title = finalUrl;
				markdown = body.trim();
			}

			if (params.max_chars && markdown.length > params.max_chars) {
				markdown = markdown.slice(0, params.max_chars);
			}

			const lines = [
				`Requested-URL: ${params.url}`,
				`URL: ${finalUrl}`,
				`Title: ${title || "(none)"}`,
				`Content-Type: ${contentType || "unknown"}`,
				`Content-Length: ${contentLength}`,
			];
			if (siteName) lines.push(`Site: ${siteName}`);
			if (byline) lines.push(`Byline: ${byline}`);
			if (language) lines.push(`Language: ${language}`);
			if (excerpt) lines.push(`Excerpt: ${excerpt}`);
			lines.push("", "Markdown:", markdown || "(empty)");
			const output = lines.join("\n");
			const truncated = withTruncationNotice(output, "web-fetch");
			const details: WebFetchDetails = {
				url: params.url,
				finalUrl,
				title: title || finalUrl,
				siteName,
				byline,
				excerpt,
				language,
				contentType,
				contentLength,
				truncation: truncated.truncation,
				fullOutputPath: truncated.fullOutputPath,
			};
			return {
				content: [{ type: "text", text: truncated.text }],
				details,
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) +
					theme.fg("muted", String(args.url ?? "")),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const isError = Boolean((result as { isError?: boolean }).isError);
			if (isError) {
				const text = result.content[0];
				return new Text(
					theme.fg(
						"error",
						text?.type === "text" ? text.text : "web_fetch failed",
					),
					0,
					0,
				);
			}
			const details = result.details as Partial<WebFetchDetails> | undefined;
			if (!details?.finalUrl || !details.title) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const lines: string[] = [
				theme.fg("muted", `Title: ${details.title}`),
				theme.fg("dim", `Content-Type: ${details.contentType || "unknown"}`),
				theme.fg("dim", `Content-Length: ${details.contentLength ?? 0}`),
			];
			if (details.siteName)
				lines.push(theme.fg("dim", `Site: ${details.siteName}`));
			if (details.byline)
				lines.push(theme.fg("dim", `Byline: ${details.byline}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
