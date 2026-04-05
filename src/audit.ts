import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import type { AuditSeverity, AuditCategory, AuditFinding, AuditSummary } from "./types";

// ─────────────────────────────────────────────
// Threat patterns
// ─────────────────────────────────────────────

interface ThreatPattern {
  name: string;
  pattern: RegExp;
  severity: AuditSeverity;
}

const HIDDEN_UNICODE: ThreatPattern[] = [
  { name: "Zero-width space", pattern: /\u200B/g, severity: "high" },
  { name: "Zero-width non-joiner", pattern: /\u200C/g, severity: "high" },
  { name: "Zero-width joiner", pattern: /\u200D/g, severity: "medium" },
  { name: "Right-to-left override", pattern: /\u202E/g, severity: "critical" },
  { name: "Left-to-right override", pattern: /\u202D/g, severity: "critical" },
  { name: "Right-to-left embedding", pattern: /\u202B/g, severity: "high" },
  { name: "Left-to-right embedding", pattern: /\u202A/g, severity: "high" },
  { name: "Pop directional formatting", pattern: /\u202C/g, severity: "medium" },
  { name: "Invisible separator", pattern: /\u2063/g, severity: "high" },
  { name: "Word joiner", pattern: /\u2060/g, severity: "medium" },
  { name: "Soft hyphen", pattern: /\u00AD/g, severity: "low" },
  { name: "Tag characters", pattern: /[\u{E0001}-\u{E007F}]/gu, severity: "critical" },
];

const PROMPT_INJECTION: ThreatPattern[] = [
  { name: "Ignore previous instructions", pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)/i, severity: "critical" },
  { name: "System prompt override", pattern: /you\s+are\s+now\s+(a|an)\s+/i, severity: "high" },
  { name: "Jailbreak attempt", pattern: /(DAN|do\s+anything\s+now|jailbreak)/i, severity: "critical" },
  { name: "Role reassignment", pattern: /from\s+now\s+on,?\s+you\s+(are|will\s+be|should\s+act)/i, severity: "high" },
  { name: "Hidden instruction marker", pattern: /\[SYSTEM\]|\[INST\]|<\|im_start\|>|<<SYS>>|<\|system\|>/i, severity: "critical" },
  { name: "Base64 encoded content", pattern: /(?:[A-Za-z0-9+/]{60,}={0,2})/g, severity: "medium" },
  { name: "Encoded instructions", pattern: /eval\(|exec\(|Function\(/g, severity: "high" },
];

const SUSPICIOUS_TOOLS: ThreatPattern[] = [
  { name: "Credential harvesting", pattern: /(password|api_key|secret|token|credential).*required/i, severity: "high" },
  { name: "Data exfiltration endpoint", pattern: /https?:\/\/[^/]*\.(tk|ml|ga|cf|gq|cc)\//i, severity: "high" },
  { name: "Localhost callback", pattern: /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i, severity: "medium" },
  { name: "Webhook to unknown host", pattern: /webhook.*https?:\/\/(?!slack|discord|github|gitlab)/i, severity: "medium" },
  { name: "Shell execution", pattern: /(child_process|subprocess|os\.system|exec\(|spawn\()/i, severity: "high" },
  { name: "File system write", pattern: /(fs\.write|open\(.*['"]w['"]|writeFile)/i, severity: "medium" },
  { name: "Network request in handler", pattern: /(fetch|axios|requests\.get|urllib|curl)/i, severity: "low" },
];

// ─────────────────────────────────────────────
// Audit engine
// ─────────────────────────────────────────────

export class AuditResult {
  findings: AuditFinding[] = [];
  filesScanned: number = 0;
  totalBytes: number = 0;

  add(finding: AuditFinding): void {
    this.findings.push(finding);
  }

  get critical(): AuditFinding[] { return this.findings.filter((f) => f.severity === "critical"); }
  get high(): AuditFinding[] { return this.findings.filter((f) => f.severity === "high"); }
  get medium(): AuditFinding[] { return this.findings.filter((f) => f.severity === "medium"); }
  get low(): AuditFinding[] { return this.findings.filter((f) => f.severity === "low"); }
  get passed(): boolean { return this.critical.length === 0 && this.high.length === 0; }

  summary(): AuditSummary {
    return {
      passed: this.passed,
      filesScanned: this.filesScanned,
      totalBytes: this.totalBytes,
      critical: this.critical.length,
      high: this.high.length,
      medium: this.medium.length,
      low: this.low.length,
      total: this.findings.length,
    };
  }
}

function scanPatterns(lines: string[], patterns: ThreatPattern[], category: AuditCategory, filePath: string, result: AuditResult): void {
  for (const check of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(check.pattern);
      if (matches) {
        result.add({
          severity: check.severity,
          category,
          file: filePath,
          line: i + 1,
          description: `${check.name} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
          snippet: lines[i].slice(0, 120),
        });
        check.pattern.lastIndex = 0;
      }
    }
  }
}

export function auditFile(filePath: string, content: string, result: AuditResult): void {
  const lines = content.split("\n");

  scanPatterns(lines, HIDDEN_UNICODE, "hidden-unicode", filePath, result);

  const isPromptFile = /\.(md|txt|prompt|instructions)$/.test(filePath) ||
    filePath.includes("system-prompt") || filePath.includes("soul/") || filePath.includes("skills/");
  if (isPromptFile) {
    scanPatterns(lines, PROMPT_INJECTION, "prompt-injection", filePath, result);
  }

  const isToolFile = /\.(js|py|ts|json)$/.test(filePath) &&
    (filePath.includes("tools/") || filePath.includes("handler") || filePath.includes("skill"));
  if (isToolFile) {
    scanPatterns(lines, SUSPICIOUS_TOOLS, "suspicious-tool", filePath, result);
  }
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

export function auditDirectory(dirPath: string, basePath?: string): AuditResult {
  const result = new AuditResult();
  const base = basePath ?? dirPath;

  for (const filePath of walkDir(dirPath)) {
    if (/\.(zip|tar|gz|png|jpg|jpeg|gif|pdf|woff|ttf|eot)$/i.test(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      result.filesScanned++;
      result.totalBytes += Buffer.byteLength(content);
      auditFile(path.relative(base, filePath), content, result);
    } catch { /* skip unreadable */ }
  }
  return result;
}

export function auditZip(zipPath: string): AuditResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-audit-"));
  try { execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: "pipe" }); }
  catch { try { execSync(`tar -xf "${zipPath}" -C "${tmpDir}"`, { stdio: "pipe" }); } catch { throw new Error("Cannot extract"); } }
  const result = auditDirectory(tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}
