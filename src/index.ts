import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { execSync } from "child_process";
import {
  FORMAT_VERSION,
  type AgentIdentity,
  type SourceInfo,
  type Memory,
  type Skill,
  type Tool,
  type CronJob,
  type Workflow,
  type WorkflowStep,
  type Integration,
  type KnowledgeDoc,
  type KnowledgeStructured,
  type Manifest,
  type PackResult,
  type ValidationResult,
  type GuardrailsConfig,
  type IdentityConfig,
  type Secret,
} from "./types";

export { FORMAT_VERSION } from "./types";
export * from "./types";

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-");
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Validate a manifest's format version. Same major = compatible, different major = refuse.
 * Missing version = treat as pre-1.0 (warn once, best-effort load).
 */
function checkFormatVersion(v: string | undefined): void {
  if (!v) {
    // Old packages may omit version; allow but warn via stderr (non-fatal).
    if (process.env.AGENTPKG_SILENT !== "1") {
      console.warn("[agentpkg] warning: manifest has no 'version' field; loading best-effort");
    }
    return;
  }
  const currentMajor = parseInt(FORMAT_VERSION.split(".")[0] ?? "1", 10);
  const manifestMajor = parseInt(String(v).split(".")[0] ?? "0", 10);
  if (Number.isNaN(manifestMajor)) {
    throw new Error(`Unparseable manifest format version: '${v}'`);
  }
  if (manifestMajor > currentMajor) {
    throw new Error(
      `Manifest format v${v} is newer than this agentpkg (v${FORMAT_VERSION}); upgrade agentpkg to load it`
    );
  }
  // Older major versions: warn but allow load (backward-compatible for now).
  if (manifestMajor < currentMajor && process.env.AGENTPKG_SILENT !== "1") {
    console.warn(
      `[agentpkg] warning: loading older format v${v} with agentpkg v${FORMAT_VERSION} — some fields may be missing`
    );
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf-8");
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Quote a path for safe use as a single shell argument (POSIX sh). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Detect archive format by reading the file's magic bytes. */
function detectArchive(filePath: string): "zip" | "gzip" | "tar" | "unknown" {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
      return "zip";
    }
    if (n >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return "gzip";
    if (n >= 512 && buf.slice(257, 262).toString("ascii") === "ustar") return "tar";
    return "unknown";
  } finally {
    fs.closeSync(fd);
  }
}

function zipDirectory(sourceDir: string, outPath: string, stripPrefix: string): void {
  const relPath = path.relative(stripPrefix, sourceDir);
  const absOut = path.resolve(outPath);
  try {
    execSync(`cd ${shq(stripPrefix)} && zip -rq ${shq(absOut)} ${shq(relPath)}`, { stdio: "pipe" });
  } catch {
    try {
      const gzPath = absOut.replace(/\.zip$/, ".tar.gz");
      execSync(`cd ${shq(stripPrefix)} && tar -czf ${shq(gzPath)} ${shq(relPath)}`, { stdio: "pipe" });
      fs.renameSync(gzPath, absOut);
    } catch {
      throw new Error("Neither zip nor tar available. Install zip: apt-get install zip");
    }
  }
}

function unzipFile(zipPath: string, destDir: string): void {
  const kind = detectArchive(zipPath);
  if (kind === "unknown") {
    throw new Error(`Not a recognized archive (no zip/gzip/tar magic bytes): ${zipPath}`);
  }
  if (kind === "zip") {
    try {
      execSync(`unzip -oq ${shq(zipPath)} -d ${shq(destDir)}`, { stdio: "pipe" });
      return;
    } catch {
      // Fall through to tar — some tar builds can read zip, but this is a last resort.
    }
  }
  try {
    execSync(`tar -xf ${shq(zipPath)} -C ${shq(destDir)}`, { stdio: "pipe" });
  } catch {
    throw new Error(`Extraction failed (${kind}). Install unzip: apt-get install unzip`);
  }
}

// ─────────────────────────────────────────────
// AgentPackage
// ─────────────────────────────────────────────

export interface AgentPackageOptions {
  name: string;
  description?: string;
  author?: string;
  tags?: string[];
}

export class AgentPackage {
  identity: AgentIdentity;
  source: SourceInfo;

  systemPrompt: string = "";
  identityConfig: IdentityConfig = {};
  guardrails: GuardrailsConfig = { rules: [], refusals: [], safetyNotes: [] };

  memories: Memory[] = [];
  skills: Skill[] = [];
  tools: Tool[] = [];
  crons: CronJob[] = [];
  subagents: AgentPackage[] = [];
  knowledgeDocs: KnowledgeDoc[] = [];
  knowledgeStructured: KnowledgeStructured[] = [];
  workflows: Workflow[] = [];
  integrations: Integration[] = [];
  assets: Array<{ filename: string; content: Buffer }> = [];
  platformRaw: Record<string, unknown> | null = null;
  secrets: Secret[] = [];

  constructor({ name, description = "", author = "", tags = [] }: AgentPackageOptions) {
    this.identity = {
      name: slugify(name),
      displayName: name,
      description,
      author,
      tags,
      createdAt: now(),
    };
    this.source = {
      platform: "unknown",
      exportedAt: now(),
      exporterVersion: FORMAT_VERSION,
    };
  }

  // ── Soul ──

  setSoul(
    systemPrompt: string,
    identityConfig: IdentityConfig = {},
    guardrails: GuardrailsConfig | null = null
  ): this {
    this.systemPrompt = systemPrompt;
    this.identityConfig = identityConfig;
    if (guardrails) this.guardrails = guardrails;
    return this;
  }

  // ── Memories ──

  addMemory(opts: {
    id: string;
    content: string;
    type?: string;
    metadata?: Record<string, unknown>;
    importance?: number;
    source?: string;
  }): this {
    this.memories.push({
      id: opts.id,
      content: opts.content,
      type: opts.type ?? "fact",
      metadata: opts.metadata ?? {},
      importance: opts.importance ?? 0.5,
      source: opts.source ?? "",
      createdAt: now(),
    });
    return this;
  }

  // ── Skills ──

  addSkill(opts: {
    name: string;
    description: string;
    instructions?: string;
    handlerCode?: string;
    handlerLanguage?: string;
    triggers?: string[];
    dependencies?: string[];
    version?: string;
  }): this {
    const lang = opts.handlerLanguage ?? "javascript";
    const ext = lang === "python" ? "py" : "js";
    this.skills.push({
      name: opts.name,
      description: opts.description,
      instructions: opts.instructions ?? "",
      handlerFile: opts.handlerCode ? `handler.${ext}` : "",
      handlerLanguage: lang,
      triggers: opts.triggers ?? [],
      dependencies: opts.dependencies ?? [],
      version: opts.version ?? "1.0.0",
      _handlerCode: opts.handlerCode ?? "",
    });
    return this;
  }

  // ── Tools ──

  addTool(opts: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    handlerCode?: string;
    handlerLanguage?: string;
    endpoint?: string;
    authType?: string;
  }): this {
    const lang = opts.handlerLanguage ?? "javascript";
    const ext = lang === "python" ? "py" : "js";
    this.tools.push({
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters ?? {},
      handlerFile: opts.handlerCode ? `handler.${ext}` : "",
      handlerLanguage: lang,
      endpoint: opts.endpoint ?? "",
      authType: opts.authType ?? "none",
      _handlerCode: opts.handlerCode ?? "",
    });
    return this;
  }

  // ── Crons ──

  addCron(opts: {
    name: string;
    schedule: string;
    action: string;
    description?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }): this {
    this.crons.push({
      name: opts.name,
      schedule: opts.schedule,
      action: opts.action,
      description: opts.description ?? "",
      enabled: opts.enabled ?? true,
      config: opts.config ?? {},
      lastRun: "",
    });
    return this;
  }

  // ── Subagents ──

  addSubagent(subagent: AgentPackage): this {
    if (!(subagent instanceof AgentPackage)) {
      throw new Error("Subagent must be an AgentPackage instance");
    }
    if (subagent === this) {
      throw new Error("Subagent cannot be the parent itself (circular reference)");
    }
    // Cycle detection: walk the descendant tree and make sure `this` is not in it
    const visited = new Set<AgentPackage>();
    const stack: AgentPackage[] = [subagent];
    while (stack.length) {
      const node = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      if (node === this) {
        throw new Error("Circular subagent reference detected");
      }
      for (const s of node.subagents) stack.push(s);
    }
    // Name collision check (would overwrite directories during writeToDir)
    if (this.subagents.some((s) => s.identity.name === subagent.identity.name)) {
      throw new Error(`Subagent name collision: '${subagent.identity.name}' already exists`);
    }
    this.subagents.push(subagent);
    return this;
  }

  // ── Knowledge ──

  addKnowledgeDoc(filename: string, content: string | Buffer): this {
    this.knowledgeDocs.push({ filename, content });
    return this;
  }

  addKnowledgeStructured(filename: string, data: Record<string, unknown>): this {
    this.knowledgeStructured.push({ filename, data });
    return this;
  }

  // ── Workflows ──

  addWorkflow(opts: {
    name: string;
    steps?: WorkflowStep[];
    description?: string;
    triggers?: string[];
  }): this {
    this.workflows.push({
      name: opts.name,
      steps: opts.steps ?? [],
      description: opts.description ?? "",
      triggers: opts.triggers ?? [],
    });
    return this;
  }

  // ── Integrations ──

  addIntegration(opts: {
    name: string;
    type: string;
    url?: string;
    config?: Record<string, unknown>;
    scopes?: string[];
  }): this {
    this.integrations.push({
      name: opts.name,
      type: opts.type,
      url: opts.url ?? "",
      config: opts.config ?? {},
      scopes: opts.scopes ?? [],
    });
    return this;
  }

  // ── Platform raw ──

  setPlatformRaw(platform: string, rawData: Record<string, unknown>): this {
    this.source.platform = platform;
    this.platformRaw = rawData;
    return this;
  }

  // ── Secrets ──

  addSecret(opts: {
    key: string;
    value: string;
    type?: Secret["type"];
    integration?: string;
    description?: string;
    expiresAt?: string;
  }): this {
    this.secrets.push({
      key: opts.key,
      value: opts.value,
      type: opts.type ?? "api_key",
      integration: opts.integration,
      description: opts.description,
      createdAt: now(),
      expiresAt: opts.expiresAt,
    });
    return this;
  }

  // ── Build manifest ──

  buildManifest(): Manifest {
    const models: string[] = [];
    if (this.identityConfig.model) models.push(this.identityConfig.model as string);

    return {
      format: "agentpkg",
      version: FORMAT_VERSION,
      agent: {
        name: this.identity.name,
        display_name: this.identity.displayName,
        description: this.identity.description,
        author: this.identity.author,
        tags: this.identity.tags,
        created_at: this.identity.createdAt,
      },
      source: {
        platform: this.source.platform,
        exported_at: this.source.exportedAt,
        exporter_version: this.source.exporterVersion,
      },
      contents: {
        soul: !!this.systemPrompt,
        memories: { count: this.memories.length },
        skills: { count: this.skills.length },
        tools: { count: this.tools.length },
        crons: { count: this.crons.length },
        subagents: { count: this.subagents.length },
        knowledge: {
          documents: this.knowledgeDocs.length,
          structured: this.knowledgeStructured.length,
        },
        workflows: { count: this.workflows.length },
        integrations: { count: this.integrations.length },
      },
      dependencies: {
        models,
        external_services: this.integrations.map((i) => i.name),
        mcp_servers: this.integrations.filter((i) => i.type === "mcp" && i.url).map((i) => i.url),
      },
    };
  }

  // ── Write to directory ──

  writeToDir(outputDir: string): string {
    const base = path.join(outputDir, `${this.identity.name}.agentpkg`);
    fs.mkdirSync(base, { recursive: true });

    writeJson(path.join(base, "manifest.json"), this.buildManifest());

    if (this.systemPrompt) {
      const soulDir = path.join(base, "soul");
      writeText(path.join(soulDir, "system-prompt.md"), this.systemPrompt);
      writeJson(path.join(soulDir, "identity.json"), this.identityConfig);
      writeJson(path.join(soulDir, "guardrails.json"), this.guardrails);
    }

    if (this.memories.length) {
      const memDir = path.join(base, "memories", "entries");
      fs.mkdirSync(memDir, { recursive: true });
      writeJson(path.join(base, "memories", "index.json"), {
        count: this.memories.length,
        types: [...new Set(this.memories.map((m) => m.type))],
        entries: this.memories.map((m) => ({ id: m.id, type: m.type, summary: m.content.slice(0, 80) })),
      });
      for (const mem of this.memories) {
        writeJson(path.join(memDir, `${mem.id}.json`), mem);
      }
    }

    if (this.skills.length) {
      const skillsDir = path.join(base, "skills");
      writeJson(path.join(skillsDir, "index.json"), {
        count: this.skills.length,
        skills: this.skills.map((s) => ({ name: s.name, description: s.description })),
      });
      for (const skill of this.skills) {
        const sd = path.join(skillsDir, skill.name);
        const { _handlerCode, instructions, ...skillMeta } = skill;
        writeJson(path.join(sd, "skill.json"), skillMeta);
        if (instructions) writeText(path.join(sd, "SKILL.md"), instructions);
        if (_handlerCode) writeText(path.join(sd, skill.handlerFile), _handlerCode);
      }
    }

    if (this.tools.length) {
      const toolsDir = path.join(base, "tools");
      writeJson(path.join(toolsDir, "index.json"), {
        count: this.tools.length,
        tools: this.tools.map((t) => ({ name: t.name, description: t.description })),
      });
      for (const tool of this.tools) {
        const td = path.join(toolsDir, tool.name);
        const { _handlerCode, ...toolMeta } = tool;
        writeJson(path.join(td, "tool.json"), toolMeta);
        if (_handlerCode) writeText(path.join(td, tool.handlerFile), _handlerCode);
      }
    }

    if (this.crons.length) {
      writeJson(path.join(base, "crons", "schedules.json"), { count: this.crons.length, jobs: this.crons });
    }

    if (this.subagents.length) {
      const subDir = path.join(base, "subagents");
      for (const sub of this.subagents) sub.writeToDir(subDir);
    }

    if (this.knowledgeDocs.length || this.knowledgeStructured.length) {
      const knowDir = path.join(base, "knowledge");
      writeJson(path.join(knowDir, "index.json"), {
        documents: this.knowledgeDocs.map((d) => d.filename),
        structured: this.knowledgeStructured.map((d) => d.filename),
      });
      if (this.knowledgeDocs.length) {
        const docDir = path.join(knowDir, "documents");
        fs.mkdirSync(docDir, { recursive: true });
        for (const doc of this.knowledgeDocs) {
          if (Buffer.isBuffer(doc.content)) fs.writeFileSync(path.join(docDir, doc.filename), doc.content);
          else writeText(path.join(docDir, doc.filename), doc.content);
        }
      }
      if (this.knowledgeStructured.length) {
        const structDir = path.join(knowDir, "structured");
        for (const sd of this.knowledgeStructured) writeJson(path.join(structDir, sd.filename), sd.data);
      }
    }

    if (this.workflows.length) {
      const wfDir = path.join(base, "workflows");
      writeJson(path.join(wfDir, "index.json"), {
        count: this.workflows.length,
        workflows: this.workflows.map((w) => ({ name: w.name, description: w.description })),
      });
      for (const wf of this.workflows) writeJson(path.join(wfDir, `${slugify(wf.name)}.json`), wf);
    }

    if (this.integrations.length) {
      writeJson(path.join(base, "integrations", "connections.json"), {
        count: this.integrations.length,
        connections: this.integrations,
      });
    }

    if (this.platformRaw) {
      writeJson(path.join(base, "meta", "platform-raw", `${this.source.platform}-export.json`), this.platformRaw);
    }

    writeJson(path.join(base, "meta", "export-log.json"), {
      exported_at: now(),
      exporter: "agentpkg-cli",
      exporter_version: FORMAT_VERSION,
      source_platform: this.source.platform,
      has_secrets: this.secrets.length > 0,
    });

    return base;
  }

  /**
   * Write encrypted secrets vault into an already-written package directory.
   * Called separately from writeToDir so secrets are only included when explicitly requested.
   */
  writeSecrets(pkgDir: string, passphrase: string): string | null {
    if (!this.secrets.length) return null;
    const { writeVault } = require("./secrets") as typeof import("./secrets");
    return writeVault(path.join(pkgDir, "secrets"), this.secrets, passphrase);
  }

  // ── Pack to zip ──

  async pack(outputPath?: string, passphrase?: string): Promise<PackResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-"));
    const pkgDir = this.writeToDir(tmpDir);

    // Encrypt and write secrets if passphrase provided
    if (passphrase && this.secrets.length) {
      this.writeSecrets(pkgDir, passphrase);
    }

    const outPath = outputPath ?? `${this.identity.name}.agentpkg.zip`;

    zipDirectory(pkgDir, outPath, path.dirname(pkgDir));

    const checksum = sha256File(outPath);
    const size = fs.statSync(outPath).size;
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { path: outPath, size, checksum };
  }

  // ── Load from directory ──

  static fromDir(dirPath: string): AgentPackage {
    const manifestPath = path.join(dirPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`manifest.json not found in ${dirPath}`);
    }
    const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (manifest.format !== "agentpkg") {
      throw new Error(`Invalid format: expected 'agentpkg', got '${manifest.format}'`);
    }
    checkFormatVersion(manifest.version);
    if (!manifest.agent || typeof manifest.agent.name !== "string") {
      throw new Error("Invalid manifest: missing required agent.name");
    }
    const pkg = new AgentPackage({
      name: manifest.agent.name,
      description: manifest.agent.description ?? "",
      author: manifest.agent.author ?? "",
      tags: manifest.agent.tags ?? [],
    });
    pkg.source = {
      platform: manifest.source?.platform ?? "unknown",
      exportedAt: manifest.source?.exported_at ?? "",
      exporterVersion: manifest.source?.exporter_version ?? FORMAT_VERSION,
    };

    const spPath = path.join(dirPath, "soul", "system-prompt.md");
    if (fs.existsSync(spPath)) pkg.systemPrompt = fs.readFileSync(spPath, "utf-8");

    const idPath = path.join(dirPath, "soul", "identity.json");
    if (fs.existsSync(idPath)) pkg.identityConfig = JSON.parse(fs.readFileSync(idPath, "utf-8"));

    const grPath = path.join(dirPath, "soul", "guardrails.json");
    if (fs.existsSync(grPath)) pkg.guardrails = JSON.parse(fs.readFileSync(grPath, "utf-8"));

    const memDir = path.join(dirPath, "memories", "entries");
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir).filter((f) => f.endsWith(".json")).sort()) {
        pkg.memories.push(JSON.parse(fs.readFileSync(path.join(memDir, f), "utf-8")));
      }
    }

    const skillIdx = path.join(dirPath, "skills", "index.json");
    if (fs.existsSync(skillIdx)) {
      const idx = JSON.parse(fs.readFileSync(skillIdx, "utf-8"));
      for (const s of idx.skills ?? []) {
        const sd = path.join(dirPath, "skills", s.name);
        const meta = fs.existsSync(path.join(sd, "skill.json"))
          ? JSON.parse(fs.readFileSync(path.join(sd, "skill.json"), "utf-8"))
          : {};
        const skillMd = path.join(sd, "SKILL.md");
        const instructions = fs.existsSync(skillMd) ? fs.readFileSync(skillMd, "utf-8") : "";
        pkg.skills.push({ ...meta, name: s.name, description: s.description ?? "", instructions });
      }
    }

    const cronPath = path.join(dirPath, "crons", "schedules.json");
    if (fs.existsSync(cronPath)) {
      pkg.crons = JSON.parse(fs.readFileSync(cronPath, "utf-8")).jobs ?? [];
    }

    const connPath = path.join(dirPath, "integrations", "connections.json");
    if (fs.existsSync(connPath)) {
      pkg.integrations = JSON.parse(fs.readFileSync(connPath, "utf-8")).connections ?? [];
    }

    const rawDir = path.join(dirPath, "meta", "platform-raw");
    if (fs.existsSync(rawDir)) {
      for (const f of fs.readdirSync(rawDir).filter((f) => f.endsWith(".json"))) {
        pkg.platformRaw = JSON.parse(fs.readFileSync(path.join(rawDir, f), "utf-8"));
      }
    }

    return pkg;
  }

  // ── Load from zip ──

  static async fromZip(zipPath: string): Promise<AgentPackage> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-unzip-"));
    unzipFile(zipPath, tmpDir);
    const entries = fs.readdirSync(tmpDir);
    const agentDir = entries.find((e) => e.endsWith(".agentpkg") && fs.statSync(path.join(tmpDir, e)).isDirectory());
    if (!agentDir) throw new Error(`No .agentpkg directory found in ${zipPath}`);
    const pkg = AgentPackage.fromDir(path.join(tmpDir, agentDir));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return pkg;
  }
}

// ─────────────────────────────────────────────
// Generic JSON Adapter
// ─────────────────────────────────────────────

const KEY_ALIASES: Record<string, string[]> = {
  soul: ["system_prompt", "systemPrompt", "prompt", "persona", "instructions", "system_message", "system", "character", "soul"],
  memory: ["memories", "memory", "context", "knowledge_base", "learned", "user_memories", "userMemories"],
  skill: ["skills", "abilities", "capabilities", "functions"],
  tool: ["tools", "actions", "tool_definitions", "function_definitions"],
  cron: ["crons", "schedules", "scheduled_tasks", "triggers", "automations"],
  name: ["name", "agent_name", "agentName", "title", "display_name", "displayName"],
  desc: ["description", "desc", "about", "bio", "summary"],
};

function findValue(data: Record<string, unknown>, keys: string[]): unknown | null {
  if (!data || typeof data !== "object") return null;
  for (const key of keys) {
    if (key in data) return data[key];
  }
  const lowerMap: Record<string, string> = {};
  for (const k of Object.keys(data)) lowerMap[k.toLowerCase()] = k;
  for (const key of keys) {
    if (key.toLowerCase() in lowerMap) return data[lowerMap[key.toLowerCase()]];
  }
  return null;
}

export function convertFromJSON(rawExport: Record<string, unknown>, platform: string = "unknown"): AgentPackage {
  const name = (findValue(rawExport, KEY_ALIASES.name) as string) ?? "imported-agent";
  const desc = (findValue(rawExport, KEY_ALIASES.desc) as string) ?? "";

  const pkg = new AgentPackage({ name, description: desc });
  pkg.setPlatformRaw(platform, rawExport);

  // Soul
  const prompt = findValue(rawExport, KEY_ALIASES.soul);
  if (prompt) {
    const modelConfig: IdentityConfig = {};
    for (const k of ["model", "model_name", "modelName", "llm"]) {
      if (k in rawExport) { modelConfig.model = rawExport[k] as string; break; }
    }
    for (const k of ["temperature", "temp"]) {
      if (k in rawExport) { modelConfig.temperature = rawExport[k] as number; break; }
    }
    for (const k of ["max_tokens", "maxTokens", "max_output"]) {
      if (k in rawExport) { modelConfig.max_tokens = rawExport[k] as number; break; }
    }
    pkg.setSoul(typeof prompt === "string" ? prompt : JSON.stringify(prompt, null, 2), modelConfig);
  }

  // Memories
  const memoriesRaw = findValue(rawExport, KEY_ALIASES.memory);
  if (Array.isArray(memoriesRaw)) {
    memoriesRaw.forEach((mem: unknown, i: number) => {
      if (typeof mem === "string") {
        pkg.addMemory({ id: `mem-${String(i).padStart(4, "0")}`, content: mem });
      } else if (typeof mem === "object" && mem !== null) {
        const m = mem as Record<string, unknown>;
        pkg.addMemory({
          id: (m.id as string) ?? `mem-${String(i).padStart(4, "0")}`,
          content: (m.content as string) ?? (m.text as string) ?? JSON.stringify(m),
          type: (m.type as string) ?? "fact",
          metadata: (m.metadata as Record<string, unknown>) ?? {},
          importance: (m.importance as number) ?? (m.weight as number) ?? 0.5,
        });
      }
    });
  }

  // Skills
  const skillsRaw = findValue(rawExport, KEY_ALIASES.skill);
  if (Array.isArray(skillsRaw)) {
    for (const skill of skillsRaw) {
      if (typeof skill === "object" && skill !== null) {
        const s = skill as Record<string, unknown>;
        pkg.addSkill({
          name: (s.name as string) ?? "unnamed-skill",
          description: (s.description as string) ?? "",
          instructions: (s.instructions as string) ?? (s.prompt as string) ?? "",
          handlerCode: (s.code as string) ?? (s.handler as string) ?? "",
          triggers: (s.triggers as string[]) ?? [],
        });
      }
    }
  }

  // Tools
  const toolsRaw = findValue(rawExport, KEY_ALIASES.tool);
  if (Array.isArray(toolsRaw)) {
    for (const tool of toolsRaw) {
      if (typeof tool === "object" && tool !== null) {
        const t = tool as Record<string, unknown>;
        pkg.addTool({
          name: (t.name as string) ?? "unnamed-tool",
          description: (t.description as string) ?? "",
          parameters: (t.parameters as Record<string, unknown>) ?? (t.input_schema as Record<string, unknown>) ?? {},
          endpoint: (t.endpoint as string) ?? (t.url as string) ?? "",
        });
      }
    }
  }

  // Crons
  const cronsRaw = findValue(rawExport, KEY_ALIASES.cron);
  if (Array.isArray(cronsRaw)) {
    for (const cron of cronsRaw) {
      if (typeof cron === "object" && cron !== null) {
        const cr = cron as Record<string, unknown>;
        pkg.addCron({
          name: (cr.name as string) ?? "unnamed-cron",
          schedule: (cr.schedule as string) ?? (cr.cron as string) ?? "",
          action: (cr.action as string) ?? (cr.task as string) ?? "",
          description: (cr.description as string) ?? "",
        });
      }
    }
  }

  // Subagents (recursive)
  for (const key of ["subagents", "sub_agents", "children", "child_agents"]) {
    if (Array.isArray(rawExport[key])) {
      for (const subRaw of rawExport[key] as unknown[]) {
        if (typeof subRaw === "object" && subRaw !== null) {
          pkg.addSubagent(convertFromJSON(subRaw as Record<string, unknown>, platform));
        }
      }
    }
  }

  // Integrations
  for (const key of ["integrations", "connections", "mcp_servers", "services"]) {
    if (Array.isArray(rawExport[key])) {
      for (const integ of rawExport[key] as unknown[]) {
        if (typeof integ === "string") {
          pkg.addIntegration({ name: integ, type: "mcp", url: integ });
        } else if (typeof integ === "object" && integ !== null) {
          const i = integ as Record<string, unknown>;
          pkg.addIntegration({
            name: (i.name as string) ?? "unknown",
            type: (i.type as string) ?? "api",
            url: (i.url as string) ?? "",
            config: (i.config as Record<string, unknown>) ?? {},
            scopes: (i.scopes as string[]) ?? [],
          });
        }
      }
    }
  }

  return pkg;
}

// ─────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────

export function validate(dirPath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [], info: [] };

  const manifestPath = path.join(dirPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    result.errors.push("Missing manifest.json");
    result.valid = false;
    return result;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    result.errors.push(`Invalid manifest.json: ${(e as Error).message}`);
    result.valid = false;
    return result;
  }

  if (manifest.format !== "agentpkg") {
    result.errors.push(`Invalid format: expected 'agentpkg', got '${manifest.format}'`);
    result.valid = false;
  }

  if (!manifest.agent?.name) {
    result.errors.push("Missing agent name in manifest");
    result.valid = false;
  }

  const contents = manifest.contents ?? ({} as Manifest["contents"]);

  if (contents.soul && !fs.existsSync(path.join(dirPath, "soul", "system-prompt.md"))) {
    result.warnings.push("Manifest declares soul but system-prompt.md missing");
  }

  const memCount = contents.memories?.count ?? 0;
  if (memCount > 0) {
    const entriesDir = path.join(dirPath, "memories", "entries");
    if (!fs.existsSync(entriesDir)) {
      result.warnings.push(`Manifest declares ${memCount} memories but entries/ missing`);
    } else {
      const actual = fs.readdirSync(entriesDir).filter((f) => f.endsWith(".json")).length;
      if (actual !== memCount) {
        result.warnings.push(`Manifest declares ${memCount} memories, found ${actual}`);
      }
    }
  }

  result.info.push(`Agent: ${manifest.agent?.display_name ?? "unknown"}`);
  result.info.push(`Version: ${manifest.version ?? "unknown"}`);
  result.info.push(`Platform: ${manifest.source?.platform ?? "unknown"}`);

  return result;
}

export async function validateZip(zipPath: string): Promise<ValidationResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-val-"));
  unzipFile(zipPath, tmpDir);
  const entries = fs.readdirSync(tmpDir);
  const agentDir = entries.find((e) => e.endsWith(".agentpkg"));
  if (!agentDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { valid: false, errors: ["No .agentpkg directory found in zip"], warnings: [], info: [] };
  }
  const result = validate(path.join(tmpDir, agentDir));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

// ─────────────────────────────────────────────
// Init scaffold
// ─────────────────────────────────────────────

export function initScaffold(name: string, outputDir: string = "."): string {
  const pkg = new AgentPackage({ name, description: "Edit this description" });
  pkg.setSoul(
    "# System Prompt\n\nReplace this with your agent's system prompt.",
    { model: "claude-sonnet-4-20250514", temperature: 0.7 },
    { rules: ["Be helpful and harmless"], refusals: [], safetyNotes: [] }
  );
  pkg.addMemory({ id: "example-001", content: "Example memory — replace or delete.", type: "fact" });
  pkg.addSkill({
    name: "example-skill",
    description: "Example skill — replace with your own",
    instructions: "# Example Skill\n\nReplace with skill instructions.",
    triggers: ["example", "demo"],
  });
  return pkg.writeToDir(outputDir);
}
