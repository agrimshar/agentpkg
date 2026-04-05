/**
 * agentpkg/adapters/openclaw — Dedicated OpenClaw filesystem adapter
 *
 * Reads a live OpenClaw data directory and converts it into AgentPackage(s).
 * Handles: openclaw.json config, workspace/ soul files, memory/*.sqlite databases,
 * skills/, cron/jobs.json, agents/ (as subagents), secrets/ (as integration configs),
 * and preserves the full original tree in meta/platform-raw/.
 *
 * Usage:
 *   agentpkg convert-openclaw ~/.config/openclaw
 *   agentpkg convert-openclaw /path/to/openclaw --agent main -o my-agent.agentpkg.zip
 *
 * SQLite reading requires the `better-sqlite3` package:
 *   npm install better-sqlite3
 */

import * as fs from "fs";
import * as path from "path";
import { AgentPackage } from "../index";

// ─────────────────────────────────────────────
// OpenClaw directory structure constants
// ─────────────────────────────────────────────

const SOUL_FILES = ["SOUL.md", "IDENTITY.md", "HEARTBEAT.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"];

const MEMORY_SUBDIRS: Record<string, string> = {
  "system": "semantic",
  "people": "fact",
  "lessons": "procedural",
  "decisions": "procedural",
  "conversations": "episodic",
  "projects": "semantic",
};

const SECRET_TO_INTEGRATION: Record<string, { type: string; name: string }> = {
  "telegram-bot-token": { type: "webhook", name: "telegram" },
  "twitter-creds": { type: "oauth", name: "twitter" },
  "bluesky-app-password": { type: "api", name: "bluesky" },
  "beehiiv-api-key": { type: "api", name: "beehiiv" },
  "gmail-app-password": { type: "api", name: "gmail" },
  "cloudflare-api-token": { type: "api", name: "cloudflare" },
  "hooks-token": { type: "webhook", name: "hooks" },
};

// ─────────────────────────────────────────────
// Main adapter
// ─────────────────────────────────────────────

export interface OpenClawConvertOptions {
  /** Which agent to treat as the root (default: "main") */
  rootAgent?: string;
  /** Whether to include session history (default: false — they're huge) */
  includeSessions?: boolean;
  /** Whether to attempt SQLite memory extraction (requires better-sqlite3) */
  extractSqliteMemories?: boolean;
  /** Whether to include media/browser screenshots (default: false) */
  includeMedia?: boolean;
  /** Whether to collect actual secret values (default: false) */
  includeSecrets?: boolean;
}

export function convertOpenClaw(
  openclawDir: string,
  options: OpenClawConvertOptions = {}
): AgentPackage {
  const {
    rootAgent = "main",
    includeSessions = false,
    extractSqliteMemories = true,
    includeMedia = false,
    includeSecrets = false,
  } = options;

  if (!fs.existsSync(openclawDir)) {
    throw new Error(`OpenClaw directory not found: ${openclawDir}`);
  }

  // ── Load openclaw.json for agent configs ──
  const configPath = path.join(openclawDir, "openclaw.json");
  const config: Record<string, unknown> = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
    : {};

  // ── Build root package from main agent + workspace ──
  const pkg = new AgentPackage({
    name: (config.name as string) ?? rootAgent,
    description: (config.description as string) ?? `OpenClaw agent: ${rootAgent}`,
    author: (config.author as string) ?? "",
  });

  pkg.setPlatformRaw("openclaw", {
    config,
    rootAgent,
    exportedFrom: openclawDir,
  });

  // ── Soul: workspace markdown files ──
  const workspaceDir = path.join(openclawDir, "workspace");
  if (fs.existsSync(workspaceDir)) {
    extractSoul(pkg, workspaceDir, config);
  }

  // ── Memories: SQLite databases ──
  if (extractSqliteMemories) {
    extractSqliteMemoriesFromDir(pkg, path.join(openclawDir, "memory"));
  }

  // ── Memories: workspace/memory/ markdown files ──
  extractWorkspaceMemories(pkg, path.join(workspaceDir, "memory"));

  // ── Skills: workspace/skills/ ──
  extractSkills(pkg, path.join(workspaceDir, "skills"));

  // ── Crons: cron/jobs.json ──
  extractCrons(pkg, path.join(openclawDir, "cron"));

  // ── Subagents: agents/* (excluding rootAgent) ──
  extractSubagents(pkg, openclawDir, rootAgent, config);

  // ── Integrations: secrets/ + credentials/ ──
  extractIntegrations(pkg, openclawDir);

  // ── Secrets: actual credential values (only if explicitly requested) ──
  if (includeSecrets) {
    const { collectSecretsFromDir } = require("../secrets") as typeof import("../secrets");
    const secretsDir = path.join(openclawDir, "secrets");
    const secrets = collectSecretsFromDir(secretsDir);
    for (const secret of secrets) {
      const mapping = SECRET_TO_INTEGRATION[secret.key];
      if (mapping) secret.integration = mapping.name;
      pkg.addSecret(secret);
    }
    // Also collect from credentials/ JSON files
    const credsDir = path.join(openclawDir, "credentials");
    if (fs.existsSync(credsDir)) {
      for (const file of fs.readdirSync(credsDir).filter((f: string) => f.endsWith(".json"))) {
        try {
          const content = fs.readFileSync(path.join(credsDir, file), "utf-8");
          pkg.addSecret({ key: `credential-${file.replace(".json", "")}`, value: content, type: "oauth_json", description: `Credential config from ${file}` });
        } catch { /* skip */ }
      }
    }
  }

  // ── Knowledge: workspace docs, project files ──
  extractKnowledge(pkg, workspaceDir);

  // ── Media assets (optional) ──
  if (includeMedia) {
    extractMedia(pkg, path.join(openclawDir, "media"));
  }

  // ── Preserve full original configs ──
  preserveRawConfigs(pkg, openclawDir);

  return pkg;
}

// ─────────────────────────────────────────────
// Soul extraction
// ─────────────────────────────────────────────

function extractSoul(
  pkg: AgentPackage,
  workspaceDir: string,
  config: Record<string, unknown>
): void {
  // Primary system prompt from SOUL.md
  const soulPath = path.join(workspaceDir, "SOUL.md");
  let systemPrompt = "";
  if (fs.existsSync(soulPath)) {
    systemPrompt = fs.readFileSync(soulPath, "utf-8");
  }

  // Identity config from IDENTITY.md + openclaw.json
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  let identityContent = "";
  if (fs.existsSync(identityPath)) {
    identityContent = fs.readFileSync(identityPath, "utf-8");
  }

  // Model config from openclaw.json
  const identityConfig: Record<string, unknown> = {
    model: config.model ?? config.defaultModel ?? "claude-sonnet-4-20250514",
    temperature: config.temperature ?? 0.7,
    identityDocument: identityContent,
  };

  // Guardrails from USER.md
  const userPath = path.join(workspaceDir, "USER.md");
  const guardrails = { rules: [] as string[], refusals: [] as string[], safetyNotes: [] as string[] };
  if (fs.existsSync(userPath)) {
    const userContent = fs.readFileSync(userPath, "utf-8");
    guardrails.rules.push(`User context document: ${userContent.slice(0, 200)}...`);
    identityConfig.userDocument = userContent;
  }

  // Heartbeat config
  const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");
  if (fs.existsSync(heartbeatPath)) {
    identityConfig.heartbeatDocument = fs.readFileSync(heartbeatPath, "utf-8");
  }

  pkg.setSoul(systemPrompt, identityConfig, guardrails);
}

// ─────────────────────────────────────────────
// SQLite memory extraction
// ─────────────────────────────────────────────

function extractSqliteMemoriesFromDir(pkg: AgentPackage, memoryDir: string): void {
  if (!fs.existsSync(memoryDir)) return;

  // Check for better-sqlite3
  let Database: any;
  try {
    Database = require("better-sqlite3");
  } catch {
    // Fallback: just note that SQLite databases exist but can't be read
    const sqliteFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".sqlite"));
    for (const file of sqliteFiles) {
      const agentName = file.replace(".sqlite", "");
      pkg.addMemory({
        id: `sqlite-${agentName}`,
        content: `[SQLite memory database for agent "${agentName}" — install better-sqlite3 to extract: npm install better-sqlite3]`,
        type: "semantic",
        metadata: { source: "sqlite", file, agentName },
        importance: 0.7,
      });
    }
    return;
  }

  // Extract from each SQLite database
  const sqliteFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".sqlite"));
  for (const file of sqliteFiles) {
    const agentName = file.replace(".sqlite", "");
    const dbPath = path.join(memoryDir, file);

    try {
      const db = new Database(dbPath, { readonly: true });

      // Try common table patterns OpenClaw might use
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;

      for (const { name: table } of tables) {
        try {
          const rows = db.prepare(`SELECT * FROM "${table}" LIMIT 1000`).all() as Record<string, unknown>[];
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const content = (row.content as string) ?? (row.text as string) ?? (row.value as string) ?? JSON.stringify(row);
            pkg.addMemory({
              id: `${agentName}-${table}-${String(i).padStart(4, "0")}`,
              content,
              type: (row.type as string) ?? "fact",
              metadata: {
                source: "sqlite",
                agent: agentName,
                table,
                ...(row.metadata ? { original: row.metadata } : {}),
              },
              importance: (row.importance as number) ?? (row.weight as number) ?? 0.5,
            });
          }
        } catch {
          // Skip tables that don't have expected columns
        }
      }

      db.close();
    } catch (err) {
      pkg.addMemory({
        id: `sqlite-err-${agentName}`,
        content: `[Could not read SQLite database for "${agentName}": ${(err as Error).message}]`,
        type: "semantic",
        metadata: { source: "sqlite-error", file },
      });
    }
  }
}

// ─────────────────────────────────────────────
// Workspace memory extraction (markdown files)
// ─────────────────────────────────────────────

function extractWorkspaceMemories(pkg: AgentPackage, memoryDir: string): void {
  if (!fs.existsSync(memoryDir)) return;

  // Daily memory files (2026-03-19.md, etc.)
  const dailyFiles = fs.readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  for (const file of dailyFiles) {
    const date = file.replace(".md", "");
    const content = fs.readFileSync(path.join(memoryDir, file), "utf-8");
    pkg.addMemory({
      id: `daily-${date}`,
      content,
      type: "episodic",
      metadata: { source: "workspace-memory", date },
      importance: 0.6,
    });
  }

  // Subdirectory memories (system/, people/, lessons/, etc.)
  for (const [subdir, memType] of Object.entries(MEMORY_SUBDIRS)) {
    const subdirPath = path.join(memoryDir, subdir);
    if (!fs.existsSync(subdirPath)) continue;

    const files = walkMarkdownFiles(subdirPath);
    for (const file of files) {
      const relPath = path.relative(subdirPath, file);
      const name = relPath.replace(/\.md$/, "").replace(/\//g, "-");
      const content = fs.readFileSync(file, "utf-8");
      pkg.addMemory({
        id: `${subdir}-${name}`,
        content,
        type: memType,
        metadata: { source: `workspace-memory/${subdir}`, file: relPath },
        importance: subdir === "system" || subdir === "people" ? 0.9 : 0.7,
      });
    }
  }

  // Heartbeat state
  const heartbeatState = path.join(memoryDir, "heartbeat-state.json");
  if (fs.existsSync(heartbeatState)) {
    const state = fs.readFileSync(heartbeatState, "utf-8");
    pkg.addMemory({
      id: "heartbeat-state",
      content: state,
      type: "semantic",
      metadata: { source: "heartbeat" },
      importance: 0.8,
    });
  }
}

// ─────────────────────────────────────────────
// Skills extraction
// ─────────────────────────────────────────────

function extractSkills(pkg: AgentPackage, skillsDir: string): void {
  if (!fs.existsSync(skillsDir)) return;

  // Top-level SKILL.md (workspace-level skill)
  const topSkill = path.join(skillsDir, "SKILL.md");
  if (fs.existsSync(topSkill)) {
    pkg.addSkill({
      name: "workspace-skill",
      description: "Root workspace skill",
      instructions: fs.readFileSync(topSkill, "utf-8"),
    });
  }

  // Named skill directories
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "reference") continue; // top-level reference is for the root skill

    const skillDir = path.join(skillsDir, entry.name);
    const skillMd = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillMd)) continue;

    const instructions = fs.readFileSync(skillMd, "utf-8");

    // Collect handler scripts
    let handlerCode = "";
    const scriptsDir = path.join(skillDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      for (const script of fs.readdirSync(scriptsDir)) {
        const scriptContent = fs.readFileSync(path.join(scriptsDir, script), "utf-8");
        handlerCode += `// --- ${script} ---\n${scriptContent}\n\n`;
      }
    }

    // Check for .skill config file
    const skillConfigs = fs.readdirSync(skillDir).filter((f) => f.endsWith(".skill"));
    let triggers: string[] = [];
    for (const cfg of skillConfigs) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(skillDir, cfg), "utf-8"));
        triggers = parsed.triggers ?? parsed.keywords ?? [];
      } catch { /* skip non-JSON skill files */ }
    }

    pkg.addSkill({
      name: entry.name,
      description: `OpenClaw skill: ${entry.name}`,
      instructions,
      handlerCode: handlerCode || undefined,
      triggers,
    });

    // Reference docs as knowledge
    const refDir = path.join(skillDir, "reference");
    if (fs.existsSync(refDir)) {
      for (const refFile of fs.readdirSync(refDir).filter((f) => f.endsWith(".md"))) {
        const refContent = fs.readFileSync(path.join(refDir, refFile), "utf-8");
        pkg.addKnowledgeDoc(`skills/${entry.name}/reference/${refFile}`, refContent);
      }
    }
  }
}

// ─────────────────────────────────────────────
// Cron extraction
// ─────────────────────────────────────────────

function extractCrons(pkg: AgentPackage, cronDir: string): void {
  if (!fs.existsSync(cronDir)) return;

  const jobsPath = path.join(cronDir, "jobs.json");
  if (!fs.existsSync(jobsPath)) return;

  try {
    const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
    const jobList = Array.isArray(jobs) ? jobs : jobs.jobs ?? [];

    for (const job of jobList) {
      if (typeof job !== "object" || !job) continue;
      const j = job as Record<string, unknown>;
      pkg.addCron({
        name: (j.name as string) ?? (j.id as string) ?? "unnamed-job",
        schedule: (j.schedule as string) ?? (j.cron as string) ?? "",
        action: (j.action as string) ?? (j.command as string) ?? (j.task as string) ?? "",
        description: (j.description as string) ?? "",
        enabled: (j.enabled as boolean) ?? true,
        config: j,
      });
    }
  } catch { /* skip malformed jobs.json */ }
}

// ─────────────────────────────────────────────
// Subagent extraction
// ─────────────────────────────────────────────

function extractSubagents(
  pkg: AgentPackage,
  openclawDir: string,
  rootAgent: string,
  config: Record<string, unknown>
): void {
  const agentsDir = path.join(openclawDir, "agents");
  if (!fs.existsSync(agentsDir)) return;

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === rootAgent) continue; // skip — it IS the root package

    const agentName = entry.name;
    const agentDir = path.join(agentsDir, agentName);

    // Build a subagent package
    const sub = new AgentPackage({
      name: agentName,
      description: `OpenClaw subagent: ${agentName}`,
    });

    // Try to extract agent-specific config from openclaw.json
    const agentConfigs = (config.agents as Record<string, unknown>[]) ?? [];
    const agentConfig = Array.isArray(agentConfigs)
      ? agentConfigs.find((a: any) => a?.name === agentName || a?.id === agentName)
      : null;

    if (agentConfig && typeof agentConfig === "object") {
      const ac = agentConfig as Record<string, unknown>;
      sub.setSoul(
        (ac.systemPrompt as string) ?? (ac.prompt as string) ?? (ac.instructions as string) ?? `You are the ${agentName} agent.`,
        { model: (ac.model as string) ?? (config.model as string) }
      );
    } else {
      sub.setSoul(`You are the ${agentName} subagent.`);
    }

    // Agent's SQLite memory
    const memDb = path.join(openclawDir, "memory", `${agentName}.sqlite`);
    if (fs.existsSync(memDb)) {
      sub.addMemory({
        id: `${agentName}-sqlite-ref`,
        content: `Memory database: ${agentName}.sqlite`,
        type: "semantic",
        metadata: { source: "sqlite-reference" },
      });
    }

    // Count active sessions
    const sessionsDir = path.join(agentDir, "sessions");
    if (fs.existsSync(sessionsDir)) {
      const activeSessions = fs.readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".deleted.") && !f.includes(".reset."))
        .length;
      sub.addMemory({
        id: `${agentName}-session-count`,
        content: `Agent has ${activeSessions} active session(s)`,
        type: "fact",
      });
    }

    // Auth profiles
    const authPath = path.join(agentDir, "agent", "auth-profiles.json");
    if (fs.existsSync(authPath)) {
      try {
        const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        if (Object.keys(auth).length > 0) {
          sub.addIntegration({
            name: `${agentName}-auth`,
            type: "oauth",
            config: { profiles: Object.keys(auth) },
          });
        }
      } catch { /* skip */ }
    }

    pkg.addSubagent(sub);
  }
}

// ─────────────────────────────────────────────
// Integration extraction
// ─────────────────────────────────────────────

function extractIntegrations(pkg: AgentPackage, openclawDir: string): void {
  const secretsDir = path.join(openclawDir, "secrets");
  if (fs.existsSync(secretsDir)) {
    for (const secret of fs.readdirSync(secretsDir)) {
      const mapping = SECRET_TO_INTEGRATION[secret];
      if (mapping) {
        pkg.addIntegration({
          name: mapping.name,
          type: mapping.type,
          config: {
            credentialRef: secret,
            note: "Credential value not included — re-configure on target platform",
          },
        });
      }
    }
  }

  // Telegram-specific config
  const telegramDir = path.join(openclawDir, "telegram");
  if (fs.existsSync(telegramDir)) {
    const existing = pkg.integrations.find((i) => i.name === "telegram");
    if (existing) {
      existing.config.telegramConfig = true;
    }
  }

  // Credentials config
  const credsDir = path.join(openclawDir, "credentials");
  if (fs.existsSync(credsDir)) {
    for (const file of fs.readdirSync(credsDir).filter((f) => f.endsWith(".json"))) {
      try {
        const cred = JSON.parse(fs.readFileSync(path.join(credsDir, file), "utf-8"));
        const name = file.replace(".json", "");
        const existing = pkg.integrations.find((i) => name.includes(i.name));
        if (existing) {
          existing.config.credentialConfig = cred;
        }
      } catch { /* skip */ }
    }
  }
}

// ─────────────────────────────────────────────
// Knowledge extraction
// ─────────────────────────────────────────────

function extractKnowledge(pkg: AgentPackage, workspaceDir: string): void {
  if (!fs.existsSync(workspaceDir)) return;

  // Top-level docs that aren't soul files
  for (const file of ["AGENTS.md", "TOOLS.md", "MEMORY.md"]) {
    const filePath = path.join(workspaceDir, file);
    if (fs.existsSync(filePath)) {
      pkg.addKnowledgeDoc(file, fs.readFileSync(filePath, "utf-8"));
    }
  }

  // Project docs
  const projectsDir = path.join(workspaceDir, "memory", "projects");
  if (fs.existsSync(projectsDir)) {
    for (const file of walkMarkdownFiles(projectsDir)) {
      const relPath = path.relative(projectsDir, file);
      pkg.addKnowledgeDoc(`projects/${relPath}`, fs.readFileSync(file, "utf-8"));
    }
  }
}

// ─────────────────────────────────────────────
// Media extraction (optional)
// ─────────────────────────────────────────────

function extractMedia(pkg: AgentPackage, mediaDir: string): void {
  if (!fs.existsSync(mediaDir)) return;

  const inboundDir = path.join(mediaDir, "inbound");
  if (fs.existsSync(inboundDir)) {
    for (const file of fs.readdirSync(inboundDir)) {
      pkg.addKnowledgeDoc(
        `media/inbound/${file}`,
        fs.readFileSync(path.join(inboundDir, file)) as unknown as string
      );
    }
  }
}

// ─────────────────────────────────────────────
// Preserve raw configs
// ─────────────────────────────────────────────

function preserveRawConfigs(pkg: AgentPackage, openclawDir: string): void {
  const rawConfigs: Record<string, unknown> = {};

  const filesToPreserve = [
    "openclaw.json",
    "exec-approvals.json",
    "subagents/runs.json",
  ];

  for (const file of filesToPreserve) {
    const filePath = path.join(openclawDir, file);
    if (fs.existsSync(filePath)) {
      try {
        rawConfigs[file] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        rawConfigs[file] = fs.readFileSync(filePath, "utf-8");
      }
    }
  }

  // Workspace state
  const wsState = path.join(openclawDir, "workspace", ".openclaw", "workspace-state.json");
  if (fs.existsSync(wsState)) {
    try {
      rawConfigs["workspace-state.json"] = JSON.parse(fs.readFileSync(wsState, "utf-8"));
    } catch { /* skip */ }
  }

  // Device identity
  const deviceJson = path.join(openclawDir, "identity", "device.json");
  if (fs.existsSync(deviceJson)) {
    try {
      rawConfigs["device.json"] = JSON.parse(fs.readFileSync(deviceJson, "utf-8"));
    } catch { /* skip */ }
  }

  pkg.setPlatformRaw("openclaw", rawConfigs);
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(full));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}
