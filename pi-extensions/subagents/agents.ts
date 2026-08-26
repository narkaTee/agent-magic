import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const BUILTIN_SCOUT: AgentConfig = {
	name: "scout",
	description:
		"Fast codebase reconnaissance using a smaller, faster model. Use for quick discovery of files, call paths, dependencies, and ownership, plus light analysis. Avoid deep reasoning and small, local, obvious changes.",
	tools: ["read", "grep", "find", "ls"],
	model: "auto-fast",
	source: "builtin",
	systemPrompt: `You are Scout, a fast codebase reconnaissance subagent.

Rules:
- You cannot see the parent agent's conversation. Use only the delegated task, repository files, and loaded project instructions.
- If required context is missing, state what is missing and proceed only with clearly labeled assumptions.
- Explore quickly and accurately using only read-only tooling. Never edit files.
- Prefer grep/find tools first, then read targeted ranges via read.
- Report concrete evidence such as exact paths, symbols, and relevant line ranges.
- Clearly distinguish verified findings from inferences.
- Mention relevant unsuccessful searches so the parent agent does not repeat them.
- Keep the response proportional to the task. A small finding needs no rigid report structure.
- Focus on reconnaissance. Leave deep reasoning, design decisions, and implementation choices to the parent agent.

Return concise findings, relevant files with why they matter.`,
};

function parseFrontmatter(content: string): {
	frontmatter: Record<string, string>;
	body: string;
} {
	if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
	const end = content.indexOf("\n---", 4);
	if (end === -1) return { frontmatter: {}, body: content };
	const raw = content.slice(4, end).trim();
	const body = content.slice(end + 4).replace(/^\r?\n/, "");
	const frontmatter: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		frontmatter[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
	}
	return { frontmatter, body };
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (
			!entry.name.endsWith(".md") ||
			(!entry.isFile() && !entry.isSymbolicLink())
		)
			continue;
		const filePath = path.join(dir, entry.name);
		let content = "";
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model || undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(
	cwd: string,
	includeProjectAgents = false,
): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = loadAgentsFromDir(userDir, "user");
	const projectAgents =
		includeProjectAgents && projectAgentsDir
			? loadAgentsFromDir(projectAgentsDir, "project")
			: [];
	const agentMap = new Map<string, AgentConfig>();

	agentMap.set(BUILTIN_SCOUT.name, BUILTIN_SCOUT);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: [...agentMap.values()], projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[]): string {
	return agents
		.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`)
		.join("\n");
}
