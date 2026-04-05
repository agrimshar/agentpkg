/**
 * agentpkg/compile — Multi-platform compiler (v2)
 *
 * Generates the real, production-accurate directory structures for each target
 * platform based on official documentation as of April 2026.
 *
 * Each compiler creates the full native tree — not just a single file.
 */

import * as fs from "fs";
import * as path from "path";
import { AgentPackage, slugify } from "./index";
import type { CompileResult } from "./types";

type CompilerFn = (pkg: AgentPackage, out: string) => CompileResult;

const COMPILERS: Record<string, CompilerFn> = {
  "claude-code": compileClaudeCode,
  "cursor": compileCursor,
  "copilot": compileCopilot,
  "windsurf": compileWindsurf,
  "crewai": compileCrewAI,
  "openai": compileOpenAI,
  "apm": compileAPM,
};

export const targets = Object.keys(COMPILERS);

export function compile(pkg: AgentPackage, target: string, outputDir: string = "."): CompileResult {
  const compiler = COMPILERS[target.toLowerCase()];
  if (!compiler) throw new Error(`Unknown target: ${target}. Valid: ${targets.join(", ")}`);
  fs.mkdirSync(outputDir, { recursive: true });
  return compiler(pkg, outputDir);
}

export function compileAll(pkg: AgentPackage, outputDir: string = "."): Record<string, CompileResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const results: Record<string, CompileResult> = {};
  for (const [target, compiler] of Object.entries(COMPILERS)) {
    const targetDir = path.join(outputDir, target);
    try { results[target] = compiler(pkg, targetDir); }
    catch (err) { results[target] = { error: (err as Error).message }; }
  }
  return results;
}

// ─── Helpers ────────────────────────────────

function w(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function wj(filePath: string, data: unknown): void {
  w(filePath, JSON.stringify(data, null, 2));
}

/**
 * Escape a string for a YAML double-quoted scalar.
 * Covers: backslashes, double-quotes, newlines, carriage returns, tabs, control chars.
 */
function yamlStr(s: string | undefined | null): string {
  const str = s == null ? "" : String(s);
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `"${escaped}"`;
}

/** Indent a block of text by `n` spaces on every line (for YAML literal blocks). */
function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text.split("\n").map((l) => pad + l).join("\n");
}

/**
 * Sanitize text for YAML block scalars (|- / |). YAML 1.2 rejects NUL and most
 * C0 controls. Strip them so `yaml.safe_load` accepts the output.
 */
function yamlBlockSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Escape a string for a Python double-quoted string literal. */
function pyStr(s: string | undefined | null): string {
  const str = s == null ? "" : String(s);
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Escape a string for a TOML basic (double-quoted) string. */
function tomlStr(s: string | undefined | null): string {
  const str = s == null ? "" : String(s);
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

function countFiles(dir: string): number {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

function importantMemories(pkg: AgentPackage, threshold = 0.7) {
  return pkg.memories.filter((m) => m.importance >= threshold);
}

function buildMemoryBlock(pkg: AgentPackage): string {
  const mems = importantMemories(pkg);
  if (!mems.length) return "";
  return "\n## Key context\n\n" + mems.map((m) => `- ${m.content}`).join("\n") + "\n";
}

function buildGuardrailBlock(pkg: AgentPackage): string {
  if (!pkg.guardrails.rules.length) return "";
  return "\n## Constraints\n\n" + pkg.guardrails.rules.map((r) => `- ${r}`).join("\n") + "\n";
}

function buildSkillBlock(pkg: AgentPackage): string {
  if (!pkg.skills.length) return "";
  let out = "\n## Skills\n";
  for (const s of pkg.skills) {
    out += `\n### ${s.name}\n${s.description}\n`;
    if (s.instructions) out += `\n${s.instructions}\n`;
  }
  return out;
}

function buildToolBlock(pkg: AgentPackage): string {
  if (!pkg.tools.length) return "";
  return "\n## Available tools\n\n" + pkg.tools.map((t) => `- **${t.name}**: ${t.description}`).join("\n") + "\n";
}

// ═══════════════════════════════════════════════
// 1. CLAUDE CODE
// Full .claude/ directory + CLAUDE.md + .mcp.json
// ═══════════════════════════════════════════════

function compileClaudeCode(pkg: AgentPackage, out: string): CompileResult {
  fs.mkdirSync(out, { recursive: true });

  // ── CLAUDE.md (root system prompt) ──
  let claude = `# ${pkg.identity.displayName}\n`;
  if (pkg.identity.description) claude += `\n${pkg.identity.description}\n`;
  if (pkg.systemPrompt) claude += `\n${pkg.systemPrompt}\n`;
  claude += buildMemoryBlock(pkg);
  claude += buildGuardrailBlock(pkg);
  claude += buildSkillBlock(pkg);
  claude += buildToolBlock(pkg);
  w(path.join(out, "CLAUDE.md"), claude);

  // ── .claude/settings.json ──
  const settings: Record<string, unknown> = {};
  if (pkg.guardrails.rules.length) {
    settings.deny = pkg.guardrails.refusals ?? [];
  }
  wj(path.join(out, ".claude", "settings.json"), settings);

  // ── .claude/rules/ (guardrails as modular rules) ──
  if (pkg.guardrails.rules.length) {
    w(path.join(out, ".claude", "rules", "guardrails.md"),
      "# Guardrails\n\n" + pkg.guardrails.rules.map((r) => `- ${r}`).join("\n") + "\n");
  }

  // ── .claude/skills/ ──
  for (const skill of pkg.skills) {
    const frontmatter = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      skill.triggers.length ? `triggers: ${JSON.stringify(skill.triggers)}` : "",
      "---",
    ].filter(Boolean).join("\n");
    w(path.join(out, ".claude", "skills", skill.name, "SKILL.md"),
      frontmatter + "\n\n" + (skill.instructions || `# ${skill.name}\n\n${skill.description}`));
    if (skill._handlerCode) {
      w(path.join(out, ".claude", "skills", skill.name, "scripts", skill.handlerFile), skill._handlerCode);
    }
  }

  // ── .claude/agents/ (subagents as agent profiles) ──
  for (const sub of pkg.subagents) {
    const agentMd = [
      "---",
      `name: ${sub.identity.name}`,
      `description: ${sub.identity.description}`,
      sub.identityConfig.model ? `model: ${sub.identityConfig.model}` : "",
      "---",
      "",
      sub.systemPrompt || `You are the ${sub.identity.displayName} agent.`,
    ].filter(Boolean).join("\n");
    w(path.join(out, ".claude", "agents", `${sub.identity.name}.md`), agentMd);
  }

  // ── .claude/commands/ (workflows as slash commands) ──
  for (const wf of pkg.workflows) {
    const cmdMd = `# ${wf.name}\n\n${wf.description}\n\n` +
      wf.steps.map((s, i) => `${i + 1}. ${s.description || s.action}`).join("\n") + "\n";
    w(path.join(out, ".claude", "commands", `${slugify(wf.name)}.md`), cmdMd);
  }

  // ── .mcp.json (integrations as MCP servers) ──
  const mcpServers: Record<string, unknown> = {};
  for (const integ of pkg.integrations.filter((i) => i.type === "mcp" && i.url)) {
    mcpServers[integ.name] = { url: integ.url, ...integ.config };
  }
  if (Object.keys(mcpServers).length) {
    wj(path.join(out, ".mcp.json"), { mcpServers });
  }

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// 2. CURSOR
// .cursor/rules/*.mdc with proper frontmatter
// ═══════════════════════════════════════════════

function compileCursor(pkg: AgentPackage, out: string): CompileResult {
  fs.mkdirSync(out, { recursive: true });

  // ── Main project rule (always-on) ──
  const mainRule = [
    "---",
    `description: ${pkg.identity.displayName} project configuration`,
    "globs: []",
    "alwaysApply: true",
    "---",
    "",
    pkg.systemPrompt || "",
    buildMemoryBlock(pkg),
    buildGuardrailBlock(pkg),
    buildToolBlock(pkg),
  ].filter(Boolean).join("\n");
  w(path.join(out, ".cursor", "rules", "project.mdc"), mainRule);

  // ── Skill rules (model-decision activation) ──
  for (const skill of pkg.skills) {
    const skillRule = [
      "---",
      `description: ${skill.description}`,
      "globs: []",
      "alwaysApply: false",
      "---",
      "",
      skill.instructions || `# ${skill.name}\n\n${skill.description}`,
    ].join("\n");
    w(path.join(out, ".cursor", "rules", `${skill.name}.mdc`), skillRule);
  }

  // ── Guardrail rules (always-on) ──
  if (pkg.guardrails.rules.length) {
    const grRule = [
      "---",
      "description: Project guardrails and constraints",
      "globs: []",
      "alwaysApply: true",
      "---",
      "",
      "# Guardrails",
      "",
      ...pkg.guardrails.rules.map((r) => `- ${r}`),
    ].join("\n");
    w(path.join(out, ".cursor", "rules", "guardrails.mdc"), grRule);
  }

  // ── AGENTS.md (cross-tool, also read by Cursor) ──
  w(path.join(out, "AGENTS.md"), buildAgentsMd(pkg));

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// 3. GITHUB COPILOT
// Full .github/ tree: instructions, agents, skills, prompts
// ═══════════════════════════════════════════════

function compileCopilot(pkg: AgentPackage, out: string): CompileResult {
  fs.mkdirSync(out, { recursive: true });

  // ── .github/copilot-instructions.md (repo-wide) ──
  let instructions = "";
  if (pkg.systemPrompt) instructions += pkg.systemPrompt + "\n";
  instructions += buildMemoryBlock(pkg);
  instructions += buildGuardrailBlock(pkg);
  w(path.join(out, ".github", "copilot-instructions.md"), instructions);

  // ── .github/instructions/*.instructions.md (path-specific) ──
  if (pkg.guardrails.rules.length) {
    const guardrailInstr = [
      "---",
      'applyTo: "**/*"',
      "---",
      "",
      "# Project guardrails",
      "",
      ...pkg.guardrails.rules.map((r) => `- ${r}`),
    ].join("\n");
    w(path.join(out, ".github", "instructions", "guardrails.instructions.md"), guardrailInstr);
  }

  // ── .github/agents/*.md (custom agent profiles) ──
  for (const sub of pkg.subagents) {
    const agentMd = [
      "---",
      `name: ${sub.identity.displayName}`,
      `description: ${sub.identity.description}`,
      `tools: [${sub.tools.map((t) => `"${t.name}"`).join(", ")}]`,
      sub.identityConfig.model ? `model: ${sub.identityConfig.model}` : "",
      "---",
      "",
      sub.systemPrompt || `You are the ${sub.identity.displayName} agent.`,
    ].filter(Boolean).join("\n");
    w(path.join(out, ".github", "agents", `${sub.identity.name}.md`), agentMd);
  }

  // ── .github/skills/*/SKILL.md ──
  for (const skill of pkg.skills) {
    const skillMd = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      "---",
      "",
      skill.instructions || `# ${skill.name}\n\n${skill.description}`,
    ].join("\n");
    w(path.join(out, ".github", "skills", skill.name, "SKILL.md"), skillMd);
  }

  // ── .github/prompts/*.prompt.md (workflows as prompts) ──
  for (const wf of pkg.workflows) {
    const promptMd = [
      "---",
      "mode: 'agent'",
      `description: '${wf.description || wf.name}'`,
      "---",
      "",
      wf.steps.map((s, i) => `${i + 1}. ${s.description || s.action}`).join("\n"),
    ].join("\n");
    w(path.join(out, ".github", "prompts", `${slugify(wf.name)}.prompt.md`), promptMd);
  }

  // ── AGENTS.md (root, cross-tool) ──
  w(path.join(out, "AGENTS.md"), buildAgentsMd(pkg));

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// 4. WINDSURF
// .windsurf/rules/*.md + legacy .windsurfrules
// ═══════════════════════════════════════════════

function compileWindsurf(pkg: AgentPackage, out: string): CompileResult {
  fs.mkdirSync(out, { recursive: true });

  // ── .windsurfrules (legacy single file, still supported) ──
  let legacy = "";
  if (pkg.systemPrompt) legacy += pkg.systemPrompt + "\n";
  legacy += buildMemoryBlock(pkg);
  legacy += buildGuardrailBlock(pkg);
  w(path.join(out, ".windsurfrules"), legacy);

  // ── .windsurf/rules/*.md (modern approach) ──
  // Main project rule
  w(path.join(out, ".windsurf", "rules", "project.md"),
    `# ${pkg.identity.displayName}\n\n` + (pkg.systemPrompt || "") +
    buildMemoryBlock(pkg) + buildToolBlock(pkg));

  // Guardrails rule
  if (pkg.guardrails.rules.length) {
    w(path.join(out, ".windsurf", "rules", "guardrails.md"),
      "# Guardrails\n\n" + pkg.guardrails.rules.map((r) => `- ${r}`).join("\n") + "\n");
  }

  // Skill rules
  for (const skill of pkg.skills) {
    w(path.join(out, ".windsurf", "rules", `${skill.name}.md`),
      `# ${skill.name}\n\n${skill.description}\n\n` + (skill.instructions || ""));
  }

  // ── AGENTS.md (cross-tool) ──
  w(path.join(out, "AGENTS.md"), buildAgentsMd(pkg));

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// 5. CREWAI
// Full project scaffold with agents.yaml + tasks.yaml + crew.py
// ═══════════════════════════════════════════════

function compileCrewAI(pkg: AgentPackage, out: string): CompileResult {
  const projectName = pkg.identity.name.replace(/-/g, "_");
  const srcDir = path.join(out, "src", projectName);
  const configDir = path.join(srcDir, "config");
  fs.mkdirSync(configDir, { recursive: true });

  // ── config/agents.yaml ──
  const agentsParts: string[] = [];
  // Main agent
  agentsParts.push(`${projectName}_agent:`);
  agentsParts.push(`  role: ${yamlStr(pkg.identity.displayName)}`);
  agentsParts.push(`  goal: ${yamlStr(pkg.identity.description)}`);
  agentsParts.push(`  backstory: |-`);
  agentsParts.push(indent(yamlBlockSafe(pkg.systemPrompt || "You are a helpful agent."), 4));
  // Subagents as additional crew members
  for (const sub of pkg.subagents) {
    const subName = sub.identity.name.replace(/-/g, "_");
    agentsParts.push("");
    agentsParts.push(`${subName}:`);
    agentsParts.push(`  role: ${yamlStr(sub.identity.displayName)}`);
    agentsParts.push(`  goal: ${yamlStr(sub.identity.description)}`);
    agentsParts.push(`  backstory: |-`);
    agentsParts.push(indent(yamlBlockSafe(sub.systemPrompt || `You are the ${sub.identity.displayName}.`), 4));
  }
  w(path.join(configDir, "agents.yaml"), agentsParts.join("\n") + "\n");

  // ── config/tasks.yaml ──
  const tasksParts: string[] = [];
  if (pkg.workflows.length) {
    for (const wf of pkg.workflows) {
      for (const step of wf.steps) {
        const taskName = slugify(step.description || step.action).replace(/-/g, "_");
        tasksParts.push(`${taskName}:`);
        tasksParts.push(`  description: ${yamlStr(step.description || step.action)}`);
        tasksParts.push(`  expected_output: "Task completed successfully"`);
        tasksParts.push(`  agent: ${projectName}_agent`);
        tasksParts.push("");
      }
    }
  } else {
    tasksParts.push(`main_task:`);
    tasksParts.push(`  description: ${yamlStr(pkg.identity.description)}`);
    tasksParts.push(`  expected_output: "Task completed successfully"`);
    tasksParts.push(`  agent: ${projectName}_agent`);
  }
  w(path.join(configDir, "tasks.yaml"), tasksParts.join("\n") + "\n");

  // ── crew.py ──
  const agentMethods = [projectName + "_agent", ...pkg.subagents.map((s) => s.identity.name.replace(/-/g, "_"))];
  let crewPy = `from crewai import Agent, Crew, Process, Task\n`;
  crewPy += `from crewai.project import CrewBase, agent, task, crew\n\n`;
  crewPy += `@CrewBase\nclass ${toPascalCase(projectName)}Crew():\n`;
  crewPy += `    """${pkg.identity.description}"""\n\n`;
  for (const name of agentMethods) {
    crewPy += `    @agent\n    def ${name}(self) -> Agent:\n`;
    crewPy += `        return Agent(config=self.agents_config["${name}"], verbose=True)\n\n`;
  }
  crewPy += `    @crew\n    def crew(self) -> Crew:\n`;
  crewPy += `        return Crew(agents=self.agents, tasks=self.tasks, process=Process.sequential, verbose=True)\n`;
  w(path.join(srcDir, "crew.py"), crewPy);

  // ── main.py ──
  const mainPy = `#!/usr/bin/env python\nfrom ${projectName}.crew import ${toPascalCase(projectName)}Crew\n\ndef run():\n    crew = ${toPascalCase(projectName)}Crew()\n    crew.crew().kickoff()\n\nif __name__ == "__main__":\n    run()\n`;
  w(path.join(srcDir, "main.py"), mainPy);
  w(path.join(srcDir, "__init__.py"), "");

  // ── tools/ ──
  if (pkg.tools.length) {
    const toolsDir = path.join(srcDir, "tools");
    w(path.join(toolsDir, "__init__.py"), "");
    for (const tool of pkg.tools) {
      const pyDocstring = (tool.description || "").replace(/"""/g, '\\"\\"\\"');
      const toolPy = `"""${pyDocstring}"""\nfrom crewai.tools import BaseTool\n\nclass ${toPascalCase(tool.name)}Tool(BaseTool):\n    name: str = ${pyStr(tool.name)}\n    description: str = ${pyStr(tool.description)}\n\n    def _run(self, **kwargs) -> str:\n        # TODO: implement\n        raise NotImplementedError\n`;
      w(path.join(toolsDir, `${tool.name.replace(/-/g, "_")}.py`), toolPy);
    }
  }

  // ── knowledge/ ──
  for (const doc of pkg.knowledgeDocs) {
    const content = typeof doc.content === "string" ? doc.content : doc.content.toString("utf-8");
    w(path.join(out, "knowledge", doc.filename), content);
  }

  // ── pyproject.toml ──
  const pyproject = `[project]\nname = ${tomlStr(pkg.identity.name)}\nversion = "1.0.0"\ndescription = ${tomlStr(pkg.identity.description)}\nrequires-python = ">=3.10,<3.13"\ndependencies = ["crewai[tools]>=0.100.0"]\n\n[project.scripts]\nrun = ${tomlStr(projectName + ".main:run")}\n\n[tool.crewai]\ntype = "crew"\n`;
  w(path.join(out, "pyproject.toml"), pyproject);

  // ── .env ──
  const model = (pkg.identityConfig.model as string) ?? "claude-sonnet-4-20250514";
  let env = `MODEL=${model}\n`;
  for (const integ of pkg.integrations) {
    env += `# ${integ.name}: configure ${integ.type} credentials\n`;
    env += `# ${integ.name.toUpperCase().replace(/-/g, "_")}_API_KEY=\n`;
  }
  w(path.join(out, ".env"), env);

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// 6. OPENAI (Responses API — successor to Assistants)
// JSON config for API deployment
// ═══════════════════════════════════════════════

function compileOpenAI(pkg: AgentPackage, out: string): CompileResult {
  fs.mkdirSync(out, { recursive: true });

  // ── Build instructions ──
  let instructions = pkg.systemPrompt ?? "";
  if (pkg.guardrails.rules.length)
    instructions += "\n\nRules:\n" + pkg.guardrails.rules.map((r) => `- ${r}`).join("\n");
  const important = importantMemories(pkg, 0.5);
  if (important.length)
    instructions += "\n\nContext:\n" + important.map((m) => `- ${m.content}`).join("\n");

  // ── Build tools array ──
  const tools: unknown[] = [];
  for (const tool of pkg.tools) {
    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    });
  }

  // ── Responses API config (primary) ──
  const responsesConfig = {
    _format: "openai-responses-api",
    _note: "Use with client.responses.create(). Assistants API sunset: Aug 26, 2026.",
    model: (pkg.identityConfig.model as string) ?? "gpt-4o",
    instructions,
    tools,
    temperature: (pkg.identityConfig.temperature as number) ?? 1.0,
    metadata: { source: "agentpkg", agent_name: pkg.identity.name },
  };
  wj(path.join(out, "openai-responses-config.json"), responsesConfig);

  // ── Assistants API config (deprecated but still active) ──
  const assistantsConfig = {
    _format: "openai-assistants-api-v2",
    _note: "Deprecated. Sunsetting August 26, 2026. Migrate to Responses API.",
    name: pkg.identity.displayName,
    description: pkg.identity.description,
    model: (pkg.identityConfig.model as string) ?? "gpt-4o",
    instructions,
    tools: tools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_resources: {},
    metadata: { source: "agentpkg" },
    temperature: (pkg.identityConfig.temperature as number) ?? 1.0,
    response_format: "auto",
  };
  wj(path.join(out, "openai-assistant-config.json"), assistantsConfig);

  // ── Knowledge files list (for vector store upload) ──
  if (pkg.knowledgeDocs.length) {
    const fileList = pkg.knowledgeDocs.map((d) => d.filename);
    wj(path.join(out, "vector-store-files.json"), {
      _note: "Upload these files to a vector store, then add vector_store_id to config",
      files: fileList,
    });
    const docsDir = path.join(out, "knowledge");
    for (const doc of pkg.knowledgeDocs) {
      const content = typeof doc.content === "string" ? doc.content : doc.content.toString("utf-8");
      w(path.join(docsDir, doc.filename), content);
    }
  }

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// 7. MICROSOFT APM
// apm.yml + .apm/ directory with all primitives
// ═══════════════════════════════════════════════

function compileAPM(pkg: AgentPackage, out: string): CompileResult {
  fs.mkdirSync(out, { recursive: true });

  // ── apm.yml manifest ──
  const apmYml = [
    `name: ${pkg.identity.name}`,
    `version: 1.0.0`,
    `description: "${pkg.identity.description}"`,
    "dependencies:",
    "  apm: []",
  ].join("\n");
  w(path.join(out, "apm.yml"), apmYml);

  // ── .apm/agents/*.agent.md ──
  const agentMd = [
    "---",
    `description: "${pkg.identity.description}"`,
    `author: ${pkg.identity.author || "agentpkg"}`,
    'version: "1.0.0"',
    "---",
    "",
    `# ${pkg.identity.displayName}`,
    "",
    pkg.systemPrompt ?? "",
  ].join("\n");
  w(path.join(out, ".apm", "agents", `${pkg.identity.name}.agent.md`), agentMd);

  // ── .apm/instructions/*.instructions.md (guardrails) ──
  if (pkg.guardrails.rules.length) {
    const instrMd = [
      "---",
      'applyTo: "**/*"',
      "description: Agent guardrails and constraints",
      "---",
      "",
      "# Guardrails",
      "",
      ...pkg.guardrails.rules.map((r) => `- ${r}`),
    ].join("\n");
    w(path.join(out, ".apm", "instructions", "guardrails.instructions.md"), instrMd);
  }

  // ── .apm/skills/*/SKILL.md ──
  for (const skill of pkg.skills) {
    w(path.join(out, ".apm", "skills", skill.name, "SKILL.md"),
      skill.instructions || `# ${skill.name}\n\n${skill.description}`);
  }

  // ── .apm/prompts/*.prompt.md (workflows) ──
  for (const wf of pkg.workflows) {
    const promptMd = [
      "---",
      `description: "${wf.description || wf.name}"`,
      "---",
      "",
      `# ${wf.name}`,
      "",
      wf.steps.map((s, i) => `${i + 1}. ${s.description || s.action}`).join("\n"),
    ].join("\n");
    w(path.join(out, ".apm", "prompts", `${slugify(wf.name)}.prompt.md`), promptMd);
  }

  // ── .apm/context/*.context.md (knowledge docs) ──
  for (const doc of pkg.knowledgeDocs) {
    const content = typeof doc.content === "string" ? doc.content : doc.content.toString("utf-8");
    w(path.join(out, ".apm", "context", doc.filename.replace(/\//g, "-")), content);
  }

  // ── Compile outputs for deployment ──
  w(path.join(out, "AGENTS.md"), buildAgentsMd(pkg));
  w(path.join(out, "CLAUDE.md"), buildClaudeMd(pkg));

  return { dir: out, files: countFiles(out) };
}

// ═══════════════════════════════════════════════
// Shared: AGENTS.md and CLAUDE.md builders
// ═══════════════════════════════════════════════

function buildAgentsMd(pkg: AgentPackage): string {
  let md = `# ${pkg.identity.displayName}\n`;
  if (pkg.identity.description) md += `\n${pkg.identity.description}\n`;
  if (pkg.systemPrompt) md += `\n## Instructions\n\n${pkg.systemPrompt}\n`;
  md += buildGuardrailBlock(pkg);
  md += buildSkillBlock(pkg);
  md += buildToolBlock(pkg);
  const mems = importantMemories(pkg);
  if (mems.length) md += "\n## Context\n\n" + mems.map((m) => `- ${m.content}`).join("\n") + "\n";
  return md;
}

function buildClaudeMd(pkg: AgentPackage): string {
  let md = `# ${pkg.identity.displayName}\n`;
  if (pkg.identity.description) md += `\n${pkg.identity.description}\n`;
  if (pkg.systemPrompt) md += `\n${pkg.systemPrompt}\n`;
  md += buildMemoryBlock(pkg);
  md += buildGuardrailBlock(pkg);
  md += buildSkillBlock(pkg);
  const mcp = pkg.integrations.filter((i) => i.type === "mcp");
  if (mcp.length) md += "\n## MCP servers\n\n" + mcp.map((m) => `- ${m.name}: \`${m.url}\``).join("\n") + "\n";
  return md;
}

// ── Utility ──

function toPascalCase(s: string): string {
  return s.split(/[-_ ]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
}
