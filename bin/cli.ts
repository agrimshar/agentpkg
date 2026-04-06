#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { AgentPackage, convertFromJSON, validate, validateZip, initScaffold, slugify, FORMAT_VERSION } from "../src/index";

const PKG_VERSION: string = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")).version;
import { auditDirectory, auditZip } from "../src/audit";
import { compile as compileTarget, compileAll, targets } from "../src/compile";
import { vaultInfo, readVault, injectSecrets } from "../src/secrets";

// ── Colors ──
const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m",
};
const log = (msg = "") => console.log(msg);
const success = (msg: string) => log(`${c.green}✓${c.reset} ${msg}`);
const warn = (msg: string) => log(`${c.yellow}⚠${c.reset} ${msg}`);
const error = (msg: string) => log(`${c.red}✗${c.reset} ${msg}`);
const info = (msg: string) => log(`${c.blue}ℹ${c.reset} ${msg}`);
const heading = (msg: string) => log(`\n${c.bold}${c.cyan}${msg}${c.reset}\n`);

// ── Arg helpers ──
function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ── Commands ──

async function cmdInit(args: string[]) {
  const name = args[0] ?? "my-agent";
  const output = getFlag(args, "--output") ?? ".";
  heading("Initializing agent package scaffold");
  const pkgDir = initScaffold(name, output);
  success(`Scaffold created at: ${c.bold}${pkgDir}`);
  log();
  info("Next steps:");
  log(`  1. Edit files in ${c.cyan}${pkgDir}${c.reset}`);
  log(`  2. Run ${c.cyan}agentpkg pack ${pkgDir}${c.reset}`);
  log();
}

async function cmdPack(args: string[]) {
  const dirPath = args[0];
  if (!dirPath) { error("Usage: agentpkg pack <dir> [--include-secrets --passphrase <p>]"); process.exit(1); }
  const output = getFlag(args, "-o");
  const passphrase = getFlag(args, "--passphrase");
  heading("Packing agent");
  const pkg = AgentPackage.fromDir(dirPath);

  if (passphrase && pkg.secrets.length) {
    info(`Encrypting ${pkg.secrets.length} secret(s) into vault`);
  } else if (pkg.secrets.length && !passphrase) {
    warn(`Package has ${pkg.secrets.length} secrets but no --passphrase provided — secrets will NOT be included`);
    pkg.secrets = [];
  }

  const result = await pkg.pack(output, passphrase);
  success(`Package created: ${c.bold}${result.path}`);
  info(`Size: ${(result.size / 1024).toFixed(1)} KB`);
  info(`SHA256: ${c.dim}${result.checksum}${c.reset}`);
  if (passphrase && pkg.secrets.length) {
    success(`${pkg.secrets.length} secret(s) encrypted in vault`);
  }
  log();
}

async function cmdValidate(args: string[]) {
  const target = args[0];
  if (!target) { error("Usage: agentpkg validate <path>"); process.exit(1); }
  heading("Validating package");
  const result = target.endsWith(".zip") ? await validateZip(target) : validate(target);
  for (const e of result.errors) error(e);
  for (const w of result.warnings) warn(w);
  for (const i of result.info) info(i);
  log();
  result.valid ? success(`${c.bold}Package is valid`) : error(`${c.bold}Package has errors`);
  log();
  process.exit(result.valid ? 0 : 1);
}

async function cmdInspect(args: string[]) {
  const target = args[0];
  if (!target) { error("Usage: agentpkg inspect <path>"); process.exit(1); }
  const pkg = target.endsWith(".zip") ? await AgentPackage.fromZip(target) : AgentPackage.fromDir(target);
  const manifest = pkg.buildManifest();
  heading(`Agent: ${manifest.agent.display_name}`);
  log(`${c.dim}${manifest.agent.description}${c.reset}`);
  log();
  const contents = manifest.contents;
  const rows: [string, string | number | boolean][] = [
    ["Soul", contents.soul ? "✓" : "—"], ["Memories", contents.memories.count || "—"],
    ["Skills", contents.skills.count || "—"], ["Tools", contents.tools.count || "—"],
    ["Crons", contents.crons.count || "—"], ["Subagents", contents.subagents.count || "—"],
    ["Documents", contents.knowledge.documents || "—"], ["Workflows", contents.workflows.count || "—"],
    ["Integrations", contents.integrations.count || "—"],
  ];
  for (const [label, value] of rows) {
    const v = value === "—" ? `${c.dim}${value}${c.reset}` : `${c.green}${c.bold}${value}${c.reset}`;
    log(`  ${label.padEnd(16)} ${v}`);
  }

  // Check for secrets vault
  if (target.endsWith(".zip")) {
    // Need to unpack temporarily to check
    const os = await import("os");
    const path = await import("path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-inspect-"));
    try {
      const { execSync } = await import("child_process");
      try { execSync(`unzip -o "${target}" -d "${tmpDir}"`, { stdio: "pipe" }); }
      catch { execSync(`tar -xf "${target}" -C "${tmpDir}"`, { stdio: "pipe" }); }
      const entries = fs.readdirSync(tmpDir);
      const agentDir = entries.find((e) => e.endsWith(".agentpkg"));
      if (agentDir) {
        const vi = vaultInfo(path.join(tmpDir, agentDir));
        if (vi) {
          log(`  ${"Secrets".padEnd(16)} ${c.yellow}${c.bold}${vi.count} (encrypted)${c.reset}`);
          log();
          info("Secret keys in vault:");
          for (const key of vi.keys) log(`  - ${key}`);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  log();
  info(`Platform: ${manifest.source.platform}`);
  info(`Format: agentpkg v${manifest.version}`);
  if (manifest.dependencies.models.length) info(`Models: ${manifest.dependencies.models.join(", ")}`);
  if (manifest.dependencies.mcp_servers.length) info(`MCP: ${manifest.dependencies.mcp_servers.join(", ")}`);
  log();
}

async function cmdUnpack(args: string[]) {
  const zipPath = args[0];
  if (!zipPath) { error("Usage: agentpkg unpack <file.zip>"); process.exit(1); }
  const output = getFlag(args, "--output") ?? ".";
  heading("Unpacking agent");
  const { execSync } = await import("child_process");
  try { execSync(`unzip -o "${zipPath}" -d "${output}"`, { stdio: "pipe" }); }
  catch { execSync(`tar -xf "${zipPath}" -C "${output}"`, { stdio: "pipe" }); }
  success(`Unpacked to: ${c.bold}${output}`);
  log();
}

async function cmdConvert(args: string[]) {
  const jsonPath = args[0];
  if (!jsonPath) { error("Usage: agentpkg convert <export.json> [--platform <n>] [--include-secrets --passphrase <p>]"); process.exit(1); }
  const platform = getFlag(args, "--platform") ?? "unknown";
  const output = getFlag(args, "-o");
  const passphrase = getFlag(args, "--passphrase");
  heading("Converting from JSON export");
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const pkg = convertFromJSON(raw, platform);
  const result = await pkg.pack(output, passphrase);
  success(`Converted and packed: ${c.bold}${result.path}`);
  info(`Size: ${(result.size / 1024).toFixed(1)} KB`);
  info(`Source platform: ${platform}`);
  log();
}

async function cmdAudit(args: string[]) {
  const target = args[0];
  if (!target) { error("Usage: agentpkg audit <path>"); process.exit(1); }
  heading("Security audit");
  const result = target.endsWith(".zip") ? auditZip(target) : auditDirectory(target);
  const summary = result.summary();
  info(`Scanned ${summary.filesScanned} files (${(summary.totalBytes / 1024).toFixed(1)} KB)`);
  log();
  for (const f of result.critical) { log(`  ${c.red}${c.bold}CRITICAL${c.reset} ${f.category} - ${f.description}`); log(`  ${c.dim}${f.file}:${f.line}${c.reset}`); log(); }
  for (const f of result.high) { log(`  ${c.red}HIGH${c.reset}     ${f.category} - ${f.description}`); log(`  ${c.dim}${f.file}:${f.line}${c.reset}`); log(); }
  for (const f of result.medium) { log(`  ${c.yellow}MEDIUM${c.reset}   ${f.category} - ${f.description}`); log(`  ${c.dim}${f.file}:${f.line}${c.reset}`); log(); }
  if (result.low.length) info(`${result.low.length} low-severity findings`);
  log();
  summary.passed ? success(`Audit passed - ${summary.total} findings`) : error(`Audit failed - ${summary.critical} critical, ${summary.high} high`);
  log();
  process.exit(summary.passed ? 0 : 1);
}

async function cmdCompile(args: string[]) {
  const target = args[0];
  if (!target) { error("Usage: agentpkg compile <path> --target <fmt> [--passphrase <p>]"); process.exit(1); }
  const format = getFlag(args, "--target") ?? "all";
  const outputDir = getFlag(args, "-o") ?? "./compiled";
  const passphrase = getFlag(args, "--passphrase");

  const pkg = target.endsWith(".zip") ? await AgentPackage.fromZip(target) : AgentPackage.fromDir(target);
  heading(`Compiling: ${pkg.identity.displayName || pkg.identity.name}`);

  // Decrypt secrets from vault if passphrase provided
  let secrets: import("../src/types").Secret[] = [];
  if (passphrase) {
    const os = await import("os");
    const path = await import("path");
    // Need to check for vault in the unpacked package
    if (target.endsWith(".zip")) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-secrets-"));
      try {
        const { execSync } = await import("child_process");
        try { execSync(`unzip -o "${target}" -d "${tmpDir}"`, { stdio: "pipe" }); }
        catch { execSync(`tar -xf "${target}" -C "${tmpDir}"`, { stdio: "pipe" }); }
        const entries = fs.readdirSync(tmpDir);
        const agentDir = entries.find((e) => e.endsWith(".agentpkg"));
        if (agentDir) {
          const vaultPath = path.join(tmpDir, agentDir, "secrets", "vault.json");
          if (fs.existsSync(vaultPath)) {
            secrets = readVault(vaultPath, passphrase);
            info(`Decrypted ${secrets.length} secret(s) from vault`);
          }
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  if (format === "all") {
    const results = compileAll(pkg, outputDir);
    for (const [fmt, result] of Object.entries(results)) {
      result.error ? warn(`${fmt}: ${result.error}`) : success(`${fmt}: ${result.file ?? result.dir}`);
      // Inject secrets into each target
      if (!result.error && secrets.length && result.dir) {
        injectSecrets(secrets, fmt, result.dir);
      }
    }
    if (secrets.length) success(`Injected ${secrets.length} secret(s) into all targets`);
  } else {
    const result = compileTarget(pkg, format, outputDir);
    success(`${format}: ${result.file ?? result.dir}`);
    if (secrets.length && result.dir) {
      injectSecrets(secrets, format, result.dir);
      success(`Injected ${secrets.length} secret(s) into ${format}`);
    }
  }

  log();
  info(`Output: ${c.bold}${outputDir}`);
  if (format === "all") info(`Targets: ${targets.join(", ")}`);
  log();
}

// ── Interactive prompt helpers ──

function createRL(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` ${c.dim}(${defaultVal})${c.reset}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askMultiline(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    log(`  ${question} ${c.dim}(enter a blank line when done)${c.reset}`);
    const lines: string[] = [];
    const collect = () => {
      rl.question("  ", (line) => {
        if (line === "") {
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
          collect();
        }
      });
    };
    collect();
  });
}

function askChoice(rl: readline.Interface, question: string, choices: string[], defaultIdx = 0): Promise<string> {
  log(`  ${question}`);
  for (let i = 0; i < choices.length; i++) {
    const marker = i === defaultIdx ? `${c.green}>${c.reset}` : " ";
    log(`  ${marker} ${i + 1}. ${choices[i]}`);
  }
  return new Promise((resolve) => {
    rl.question(`  ${c.dim}Choose [${defaultIdx + 1}]:${c.reset} `, (answer) => {
      const idx = parseInt(answer, 10) - 1;
      resolve(choices[idx >= 0 && idx < choices.length ? idx : defaultIdx]);
    });
  });
}

// ── Interactive: create ──

async function cmdCreate(args: string[]) {
  const rl = createRL();
  heading("Create a new agent");
  log(`  ${c.dim}Answer a few questions and your agent will be ready to go.${c.reset}`);
  log();

  const name = await ask(rl, "What should we call this agent?", "my-agent");
  const description = await ask(rl, "Describe what it does (one sentence)");
  const author = await ask(rl, "Author name", process.env.USER || "");

  log();
  log(`  ${c.bold}Now let's give it a personality.${c.reset}`);
  const systemPrompt = await askMultiline(rl, "Write the system prompt (what should this agent be like?)");

  const model = await askChoice(rl, "Which model should it use?", [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "gpt-4o",
    "gpt-4",
    "other",
  ], 0);

  let finalModel = model;
  if (model === "other") {
    finalModel = await ask(rl, "Enter model name");
  }

  const tempStr = await ask(rl, "Temperature (0.0 = precise, 1.0 = creative)", "0.5");
  const temperature = parseFloat(tempStr) || 0.5;

  // Rules
  log();
  log(`  ${c.bold}Any rules this agent must follow?${c.reset}`);
  const rulesRaw = await askMultiline(rl, "Enter rules, one per line");
  const rules = rulesRaw.split("\n").filter(r => r.trim());

  // Memories
  log();
  const addMemories = await ask(rl, "Add some memories? (things the agent should know)", "y");
  const memories: Array<{ id: string; content: string; type: string; importance: number }> = [];
  if (addMemories.toLowerCase().startsWith("y")) {
    log(`  ${c.dim}Enter memories one at a time. Leave blank to stop.${c.reset}`);
    let memIdx = 1;
    while (true) {
      const content = await ask(rl, `Memory ${memIdx}`);
      if (!content) break;
      const type = await askChoice(rl, "What kind of memory is this?", ["fact", "preference", "procedural"], 0);
      const impStr = await ask(rl, "How important? (0.0 to 1.0)", "0.7");
      memories.push({ id: `mem-${String(memIdx).padStart(3, "0")}`, content, type, importance: parseFloat(impStr) || 0.7 });
      memIdx++;
    }
  }

  // Skills
  log();
  const addSkills = await ask(rl, "Add skills? (specific things the agent can do)", "n");
  const skills: Array<{ name: string; description: string; instructions: string }> = [];
  if (addSkills.toLowerCase().startsWith("y")) {
    log(`  ${c.dim}Enter skills one at a time. Leave blank to stop.${c.reset}`);
    while (true) {
      const skillName = await ask(rl, "Skill name");
      if (!skillName) break;
      const skillDesc = await ask(rl, "What does this skill do?");
      const skillInstructions = await askMultiline(rl, "Instructions for this skill");
      skills.push({ name: slugify(skillName), description: skillDesc, instructions: skillInstructions });
    }
  }

  rl.close();

  // Build the package
  log();
  heading("Building your agent");

  const outputDir = getFlag(args, "-o") || ".";
  const pkg = new AgentPackage({ name, description, author });
  pkg.setSoul(systemPrompt, { model: finalModel, temperature }, rules.length ? { rules, refusals: [], safetyNotes: [] } : null);

  for (const mem of memories) pkg.addMemory(mem);
  for (const skill of skills) pkg.addSkill(skill);

  const dir = pkg.writeToDir(outputDir);
  success(`Agent created at: ${c.bold}${dir}`);
  log();
  info("What you can do next:");
  log(`  ${c.cyan}agentpkg pack ${dir}${c.reset}              Bundle it into a .zip`);
  log(`  ${c.cyan}agentpkg compile ${dir} --target all${c.reset}  Compile to all platforms`);
  log(`  ${c.cyan}agentpkg add memory ${dir}${c.reset}         Add more memories`);
  log(`  ${c.cyan}agentpkg add skill ${dir}${c.reset}          Add more skills`);
  log();
}

// ── Interactive: add ──

async function cmdAdd(args: string[]) {
  const subCmd = args[0];
  const targetDir = args[1];

  if (!subCmd || !targetDir) {
    error("Usage: agentpkg add <memory|skill|tool|secret|cron|rule> <agent-dir>");
    log();
    log(`  ${c.bold}Examples:${c.reset}`);
    log(`    agentpkg add memory my-agent.agentpkg`);
    log(`    agentpkg add skill my-agent.agentpkg`);
    log(`    agentpkg add tool my-agent.agentpkg`);
    log(`    agentpkg add secret my-agent.agentpkg`);
    log(`    agentpkg add cron my-agent.agentpkg`);
    log(`    agentpkg add rule my-agent.agentpkg`);
    log();
    process.exit(1);
  }

  if (!fs.existsSync(targetDir)) { error(`Directory not found: ${targetDir}`); process.exit(1); }

  const rl = createRL();

  switch (subCmd) {
    case "memory": {
      heading("Add a memory");
      const entriesDir = path.join(targetDir, "memories", "entries");
      fs.mkdirSync(entriesDir, { recursive: true });

      const existing = fs.existsSync(entriesDir) ? fs.readdirSync(entriesDir).length : 0;
      let idx = existing + 1;

      log(`  ${c.dim}Enter memories one at a time. Leave blank to stop.${c.reset}`);
      let added = 0;
      while (true) {
        const content = await ask(rl, `Memory ${idx}`);
        if (!content) break;
        const type = await askChoice(rl, "Type?", ["fact", "preference", "procedural", "episodic"], 0);
        const impStr = await ask(rl, "Importance (0.0 to 1.0)", "0.7");
        const id = `mem-${String(idx).padStart(3, "0")}`;
        const memory = {
          id, content, type,
          metadata: {},
          importance: parseFloat(impStr) || 0.7,
          source: "cli",
          createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(entriesDir, `${id}.json`), JSON.stringify(memory, null, 2));
        success(`Added: ${id}`);
        idx++;
        added++;
      }

      // Update index.json
      const allEntries = fs.readdirSync(entriesDir).filter(f => f.endsWith(".json")).sort();
      const indexEntries = allEntries.map(f => {
        const m = JSON.parse(fs.readFileSync(path.join(entriesDir, f), "utf-8"));
        return { id: m.id, type: m.type, summary: m.content.slice(0, 80) };
      });
      fs.writeFileSync(path.join(targetDir, "memories", "index.json"), JSON.stringify({
        count: allEntries.length,
        types: [...new Set(indexEntries.map(e => e.type))],
        entries: indexEntries,
      }, null, 2));

      log();
      success(`${added} memory(s) added. Total: ${allEntries.length}`);
      break;
    }

    case "skill": {
      heading("Add a skill");
      const skillsDir = path.join(targetDir, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });

      let added = 0;
      log(`  ${c.dim}Enter skills one at a time. Leave blank to stop.${c.reset}`);
      while (true) {
        const skillName = await ask(rl, "Skill name");
        if (!skillName) break;
        const slug = slugify(skillName);
        const description = await ask(rl, "What does this skill do?");
        const instructions = await askMultiline(rl, "Write the instructions for this skill");

        const sd = path.join(skillsDir, slug);
        fs.mkdirSync(sd, { recursive: true });
        fs.writeFileSync(path.join(sd, "skill.json"), JSON.stringify({
          name: slug, description, handlerFile: "", handlerLanguage: "",
          triggers: [], dependencies: [], version: "1.0.0",
        }, null, 2));
        if (instructions) fs.writeFileSync(path.join(sd, "SKILL.md"), instructions);
        success(`Added skill: ${slug}`);
        added++;
      }

      // Update skills index.json
      const allSkills = fs.readdirSync(skillsDir).filter(f => {
        return fs.statSync(path.join(skillsDir, f)).isDirectory();
      });
      const skillIndex = allSkills.map(name => {
        const meta = JSON.parse(fs.readFileSync(path.join(skillsDir, name, "skill.json"), "utf-8"));
        return { name, description: meta.description || "" };
      });
      fs.writeFileSync(path.join(skillsDir, "index.json"), JSON.stringify({
        count: allSkills.length, skills: skillIndex,
      }, null, 2));

      log();
      success(`${added} skill(s) added. Total: ${allSkills.length}`);
      break;
    }

    case "tool": {
      heading("Add a tool");
      const toolsDir = path.join(targetDir, "tools");
      fs.mkdirSync(toolsDir, { recursive: true });

      let added = 0;
      log(`  ${c.dim}Enter tools one at a time. Leave blank to stop.${c.reset}`);
      while (true) {
        const toolName = await ask(rl, "Tool name");
        if (!toolName) break;
        const slug = slugify(toolName);
        const description = await ask(rl, "What does this tool do?");

        const td = path.join(toolsDir, slug);
        fs.mkdirSync(td, { recursive: true });
        fs.writeFileSync(path.join(td, "tool.json"), JSON.stringify({
          name: slug, description,
          parameters: { type: "object", properties: {}, required: [] },
          handlerFile: "", handlerLanguage: "", endpoint: "",
        }, null, 2));
        success(`Added tool: ${slug}`);
        added++;
      }

      log();
      success(`${added} tool(s) added`);
      break;
    }

    case "secret": {
      heading("Add a secret");
      const secretsDir = path.join(targetDir, "secrets");
      fs.mkdirSync(secretsDir, { recursive: true });

      let added = 0;
      log(`  ${c.dim}Enter secrets one at a time. Leave blank to stop.${c.reset}`);
      log(`  ${c.dim}Values are stored as plaintext files here. Use --passphrase when packing to encrypt.${c.reset}`);
      while (true) {
        const key = await ask(rl, "Secret name (e.g. OPENAI_API_KEY)");
        if (!key) break;
        const value = await ask(rl, "Value");
        if (!value) { warn("Skipped (empty value)"); continue; }
        fs.writeFileSync(path.join(secretsDir, key), value);
        success(`Added secret: ${key}`);
        added++;
      }

      log();
      success(`${added} secret(s) added. Remember to use ${c.cyan}--passphrase${c.reset} when packing.`);
      break;
    }

    case "cron": {
      heading("Add a scheduled task");
      const cronsDir = path.join(targetDir, "crons");
      fs.mkdirSync(cronsDir, { recursive: true });

      const schedulesPath = path.join(cronsDir, "schedules.json");
      const existing = fs.existsSync(schedulesPath)
        ? JSON.parse(fs.readFileSync(schedulesPath, "utf-8"))
        : { count: 0, jobs: [] };

      let added = 0;
      log(`  ${c.dim}Enter cron jobs one at a time. Leave blank to stop.${c.reset}`);
      while (true) {
        const cronName = await ask(rl, "Task name");
        if (!cronName) break;
        const schedule = await ask(rl, "Cron schedule (e.g. 0 8 * * * for daily at 8am)", "0 8 * * *");
        const action = await ask(rl, "What should it do?");
        existing.jobs.push({ name: slugify(cronName), schedule, action });
        success(`Added cron: ${slugify(cronName)}`);
        added++;
      }

      existing.count = existing.jobs.length;
      fs.writeFileSync(schedulesPath, JSON.stringify(existing, null, 2));

      log();
      success(`${added} cron(s) added. Total: ${existing.count}`);
      break;
    }

    case "rule": {
      heading("Add guardrail rules");
      const grPath = path.join(targetDir, "soul", "guardrails.json");
      const existing = fs.existsSync(grPath)
        ? JSON.parse(fs.readFileSync(grPath, "utf-8"))
        : { rules: [], refusals: [], safetyNotes: [] };

      let added = 0;
      log(`  ${c.dim}Enter rules one at a time. Leave blank to stop.${c.reset}`);
      while (true) {
        const rule = await ask(rl, "Rule");
        if (!rule) break;
        existing.rules.push(rule);
        success(`Added rule: ${rule}`);
        added++;
      }

      fs.mkdirSync(path.join(targetDir, "soul"), { recursive: true });
      fs.writeFileSync(grPath, JSON.stringify(existing, null, 2));

      log();
      success(`${added} rule(s) added. Total: ${existing.rules.length}`);
      break;
    }

    default:
      error(`Unknown: agentpkg add ${subCmd}`);
      log(`  Valid: memory, skill, tool, secret, cron, rule`);
      process.exit(1);
  }

  rl.close();
  log();
}

// ── Interactive: set ──

async function cmdSet(args: string[]) {
  const subCmd = args[0];
  const targetDir = args[1];

  if (!subCmd || !targetDir) {
    error("Usage: agentpkg set <soul|model|description> <agent-dir>");
    log();
    log(`  ${c.bold}Examples:${c.reset}`);
    log(`    agentpkg set soul my-agent.agentpkg`);
    log(`    agentpkg set model my-agent.agentpkg`);
    log(`    agentpkg set description my-agent.agentpkg`);
    log();
    process.exit(1);
  }

  if (!fs.existsSync(targetDir)) { error(`Directory not found: ${targetDir}`); process.exit(1); }

  const rl = createRL();

  switch (subCmd) {
    case "soul": {
      heading("Set system prompt");
      const soulDir = path.join(targetDir, "soul");
      fs.mkdirSync(soulDir, { recursive: true });
      const spPath = path.join(soulDir, "system-prompt.md");
      if (fs.existsSync(spPath)) {
        log(`  ${c.dim}Current prompt:${c.reset}`);
        const current = fs.readFileSync(spPath, "utf-8");
        for (const line of current.split("\n").slice(0, 5)) log(`  ${c.dim}  ${line}${c.reset}`);
        if (current.split("\n").length > 5) log(`  ${c.dim}  ...${c.reset}`);
        log();
      }
      const prompt = await askMultiline(rl, "Write the new system prompt");
      if (prompt) {
        fs.writeFileSync(spPath, prompt);
        success("System prompt updated");
      } else {
        warn("No changes (empty input)");
      }
      break;
    }

    case "model": {
      heading("Set model");
      const soulDir = path.join(targetDir, "soul");
      fs.mkdirSync(soulDir, { recursive: true });
      const idPath = path.join(soulDir, "identity.json");
      const existing = fs.existsSync(idPath) ? JSON.parse(fs.readFileSync(idPath, "utf-8")) : {};
      if (existing.model) info(`Current model: ${existing.model}`);

      const model = await askChoice(rl, "Which model?", [
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514",
        "gpt-4o",
        "gpt-4",
        "other",
      ], 0);

      let finalModel = model;
      if (model === "other") finalModel = await ask(rl, "Enter model name");

      const tempStr = await ask(rl, "Temperature", String(existing.temperature ?? 0.5));
      existing.model = finalModel;
      existing.temperature = parseFloat(tempStr) || 0.5;
      fs.writeFileSync(idPath, JSON.stringify(existing, null, 2));
      success(`Model set to: ${finalModel} (temperature: ${existing.temperature})`);
      break;
    }

    case "description": {
      heading("Set description");
      const manifestPath = path.join(targetDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) { error("No manifest.json found. Is this an agent directory?"); process.exit(1); }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (manifest.agent?.description) info(`Current: ${manifest.agent.description}`);
      const desc = await ask(rl, "New description");
      if (desc) {
        manifest.agent.description = desc;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        success("Description updated");
      }
      break;
    }

    default:
      error(`Unknown: agentpkg set ${subCmd}`);
      log(`  Valid: soul, model, description`);
      process.exit(1);
  }

  rl.close();
  log();
}

// ── Help ──

function showHelp() {
  log(`\n${c.cyan}${c.bold}  agentpkg${c.reset}  v${PKG_VERSION} — Universal AI Agent Package Format\n`);
  log(`${c.bold}CREATE & MODIFY${c.reset}`);
  log(`  ${c.cyan}create${c.reset}                          Interactive agent builder`);
  log(`  ${c.cyan}add${c.reset}       <type> <dir>          Add memory, skill, tool, secret, cron, or rule`);
  log(`  ${c.cyan}set${c.reset}       <field> <dir>         Update soul, model, or description`);
  log();
  log(`${c.bold}BUILD & DEPLOY${c.reset}`);
  log(`  ${c.cyan}init${c.reset}      <name>                Scaffold an empty agent package`);
  log(`  ${c.cyan}pack${c.reset}      <dir>                 Zip an .agentpkg directory`);
  log(`  ${c.cyan}compile${c.reset}   <path>                Compile to platform format`);
  log();
  log(`${c.bold}INSPECT & VERIFY${c.reset}`);
  log(`  ${c.cyan}validate${c.reset}  <path>                Validate structure`);
  log(`  ${c.cyan}inspect${c.reset}   <path>                Show contents + secrets summary`);
  log(`  ${c.cyan}audit${c.reset}     <path>                Security scan`);
  log(`  ${c.cyan}unpack${c.reset}    <zip>                 Extract a package`);
  log(`  ${c.cyan}convert${c.reset}   <json>                Convert any JSON to agentpkg`);
  log();
  log(`${c.bold}COMPILE TARGETS${c.reset}  (--target <fmt>)`);
  log(`  claude-code | cursor | copilot | windsurf | crewai | openai | apm | all`);
  log();
  log(`${c.bold}FLAGS${c.reset}`);
  log(`  --passphrase <phrase>          Encrypt/decrypt secrets (AES-256-GCM)`);
  log(`  --target <fmt>                 Compile target`);
  log(`  -o <path>                      Output path`);
  log();
  log(`${c.bold}EXAMPLES${c.reset}`);
  log(`  ${c.dim}# Build an agent interactively${c.reset}`);
  log(`  agentpkg create`);
  log();
  log(`  ${c.dim}# Add memories to an existing agent${c.reset}`);
  log(`  agentpkg add memory my-agent.agentpkg`);
  log();
  log(`  ${c.dim}# Change the system prompt${c.reset}`);
  log(`  agentpkg set soul my-agent.agentpkg`);
  log();
  log(`  ${c.dim}# Pack with encrypted secrets${c.reset}`);
  log(`  agentpkg pack ./agent --passphrase "my-migration-key"`);
  log();
  log(`  ${c.dim}# Compile to all platforms${c.reset}`);
  log(`  agentpkg compile agent.zip --target all`);
  log();
}

// ── Main ──

const commands: Record<string, (args: string[]) => Promise<void>> = {
  create: cmdCreate, add: cmdAdd, set: cmdSet,
  init: cmdInit, pack: cmdPack, validate: cmdValidate, inspect: cmdInspect,
  unpack: cmdUnpack, convert: cmdConvert, audit: cmdAudit, compile: cmdCompile,
};

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") { showHelp(); return; }
  if (cmd === "--version" || cmd === "-v") { log(PKG_VERSION); return; }
  if (!(cmd in commands)) { error(`Unknown: ${cmd}. Run agentpkg --help`); process.exit(1); }
  try { await commands[cmd](args.slice(1)); }
  catch (err) { error((err as Error).message); if (process.env.DEBUG) console.error(err); process.exit(1); }
}

main();
