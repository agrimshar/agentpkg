#!/usr/bin/env node

import * as fs from "fs";
import { AgentPackage, convertFromJSON, validate, validateZip, initScaffold, FORMAT_VERSION } from "../src/index";
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

// ── Help ──

function showHelp() {
  log(`\n${c.cyan}${c.bold}  agentpkg${c.reset}  v${FORMAT_VERSION} — Universal AI Agent Package Format\n`);
  log(`${c.bold}COMMANDS${c.reset}`);
  log(`  ${c.cyan}init${c.reset}      <n>              Scaffold a new agent package`);
  log(`  ${c.cyan}pack${c.reset}      <dir>               Zip an .agentpkg directory`);
  log(`  ${c.cyan}validate${c.reset}  <path>              Validate structure`);
  log(`  ${c.cyan}inspect${c.reset}   <path>              Show contents + secrets summary`);
  log(`  ${c.cyan}unpack${c.reset}    <zip>               Extract a package`);
  log(`  ${c.cyan}convert${c.reset}   <json>              Convert any JSON to agentpkg`);
  log(`  ${c.cyan}audit${c.reset}     <path>              Security scan`);
  log(`  ${c.cyan}compile${c.reset}   <path>              Compile to platform format`);
  log();
  log(`${c.bold}COMPILE TARGETS${c.reset}  (--target <fmt>)`);
  log(`  claude-code | cursor | copilot | windsurf | crewai | openai | apm | all`);
  log();
  log(`${c.bold}SECRETS${c.reset}`);
  log(`  --include-secrets              Include credential values in package`);
  log(`  --passphrase <phrase>          Encrypt/decrypt secrets (AES-256-GCM)`);
  log();
  log(`${c.bold}EXAMPLES${c.reset}`);
  log(`  ${c.dim}# Pack with encrypted secrets${c.reset}`);
  log(`  agentpkg pack ./agent --passphrase "my-migration-key"`);
  log();
  log(`  ${c.dim}# Compile and inject secrets into target${c.reset}`);
  log(`  agentpkg compile agent.zip --target claude-code --passphrase "my-migration-key"`);
  log();
  log(`  ${c.dim}# Inspect a package (shows secret keys without decrypting)${c.reset}`);
  log(`  agentpkg inspect agent.agentpkg.zip`);
  log();
}

// ── Main ──

const commands: Record<string, (args: string[]) => Promise<void>> = {
  init: cmdInit, pack: cmdPack, validate: cmdValidate, inspect: cmdInspect,
  unpack: cmdUnpack, convert: cmdConvert, audit: cmdAudit, compile: cmdCompile,
};

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") { showHelp(); return; }
  if (!(cmd in commands)) { error(`Unknown: ${cmd}. Run agentpkg --help`); process.exit(1); }
  try { await commands[cmd](args.slice(1)); }
  catch (err) { error((err as Error).message); if (process.env.DEBUG) console.error(err); process.exit(1); }
}

main();
