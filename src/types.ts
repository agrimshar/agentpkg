// ─────────────────────────────────────────────
// Core types for the agentpkg format
// ─────────────────────────────────────────────

export const FORMAT_VERSION = "1.0.0";

export interface AgentIdentity {
  name: string;
  displayName: string;
  description: string;
  author: string;
  tags: string[];
  createdAt: string;
}

export interface SourceInfo {
  platform: string;
  exportedAt: string;
  exporterVersion: string;
}

export interface Memory {
  id: string;
  content: string;
  type: "fact" | "preference" | "episodic" | "semantic" | "procedural" | string;
  metadata: Record<string, unknown>;
  importance: number;
  source: string;
  createdAt: string;
}

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  handlerFile: string;
  handlerLanguage: string;
  triggers: string[];
  dependencies: string[];
  version: string;
  _handlerCode?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handlerFile: string;
  handlerLanguage: string;
  endpoint: string;
  authType: string;
  _handlerCode?: string;
}

export interface CronJob {
  name: string;
  schedule: string;
  action: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  lastRun: string;
}

export interface Workflow {
  name: string;
  description: string;
  steps: WorkflowStep[];
  triggers: string[];
}

export interface WorkflowStep {
  step?: number;
  action: string;
  description?: string;
  skill?: string;
  tool?: string;
  subagent?: string;
  integration?: string;
  [key: string]: unknown;
}

export interface Integration {
  name: string;
  type: "mcp" | "api" | "webhook" | "oauth" | string;
  url: string;
  config: Record<string, unknown>;
  scopes: string[];
}

export interface KnowledgeDoc {
  filename: string;
  content: string | Buffer;
}

export interface KnowledgeStructured {
  filename: string;
  data: Record<string, unknown>;
}

export interface Manifest {
  format: "agentpkg";
  version: string;
  agent: {
    name: string;
    display_name: string;
    description: string;
    author: string;
    tags: string[];
    created_at: string;
  };
  source: {
    platform: string;
    exported_at: string;
    exporter_version: string;
  };
  contents: {
    soul: boolean;
    memories: { count: number };
    skills: { count: number };
    tools: { count: number };
    crons: { count: number };
    subagents: { count: number };
    knowledge: { documents: number; structured: number };
    workflows: { count: number };
    integrations: { count: number };
  };
  dependencies: {
    models: string[];
    external_services: string[];
    mcp_servers: string[];
  };
}

export interface PackResult {
  path: string;
  size: number;
  checksum: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

export interface GuardrailsConfig {
  rules: string[];
  refusals: string[];
  safetyNotes: string[];
}

export interface IdentityConfig {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────
// Audit types
// ─────────────────────────────────────────────

export type AuditSeverity = "critical" | "high" | "medium" | "low";
export type AuditCategory = "hidden-unicode" | "prompt-injection" | "suspicious-tool";

export interface AuditFinding {
  severity: AuditSeverity;
  category: AuditCategory;
  file: string;
  line: number;
  description: string;
  snippet: string;
}

export interface AuditSummary {
  passed: boolean;
  filesScanned: number;
  totalBytes: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

// ─────────────────────────────────────────────
// Dependency types
// ─────────────────────────────────────────────

export type DepType = "git" | "npm" | "local" | "url";

export interface DepSpec {
  type: DepType;
  source: string;
  raw: string;
  ref?: string;
  version?: string;
}

export interface LockfileData {
  version: number;
  resolved: Record<string, ResolvedDep>;
  dependency_tree: Record<string, string[]>;
}

export interface ResolvedDep {
  type: DepType;
  source: string;
  resolved_at: string;
  checksum: string | null;
  dependencies: string[];
  ref?: string;
  resolved_ref?: string;
  version?: string;
  resolved_version?: string;
  resolved_path?: string;
  _note?: string;
}

// ─────────────────────────────────────────────
// Compile types
// ─────────────────────────────────────────────

export type CompileTarget =
  | "claude-code"
  | "cursor"
  | "copilot"
  | "windsurf"
  | "openai"
  | "crewai"
  | "apm"
  | "all";

export interface CompileResult {
  file?: string;
  dir?: string;
  size?: number;
  files?: number;
  error?: string;
}

// ─────────────────────────────────────────────
// Secrets types
// ─────────────────────────────────────────────

export interface Secret {
  /** Unique key, e.g. "telegram-bot-token", "openai-api-key" */
  key: string;
  /** The actual secret value (plaintext in memory, encrypted on disk) */
  value: string;
  /** Which integration this credential belongs to */
  integration?: string;
  /** What type of credential: api_key, token, password, oauth_json, certificate */
  type: "api_key" | "token" | "password" | "oauth_json" | "certificate" | "other";
  /** Optional description */
  description?: string;
  /** When it was added */
  createdAt?: string;
  /** Optional expiry */
  expiresAt?: string;
}

export interface EncryptedVault {
  /** Always "agentpkg-vault" */
  format: "agentpkg-vault";
  /** Encryption algorithm used */
  algorithm: "aes-256-gcm";
  /** Key derivation function */
  kdf: "scrypt";
  /** Base64-encoded salt for key derivation */
  salt: string;
  /** Base64-encoded IV for AES-GCM */
  iv: string;
  /** Base64-encoded GCM auth tag */
  authTag: string;
  /** Base64-encoded encrypted payload (JSON array of Secret objects) */
  ciphertext: string;
  /** Number of secrets inside (metadata only, not sensitive) */
  count: number;
  /** Secret keys (not values) for reference without decrypting */
  keys: string[];
}

