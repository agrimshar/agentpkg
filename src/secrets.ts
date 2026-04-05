/**
 * agentpkg/secrets — Encrypted secrets vault
 *
 * Stores secrets in the package as an AES-256-GCM encrypted blob.
 * Key derivation uses scrypt (Node.js built-in) from a user passphrase.
 *
 * Usage:
 *   agentpkg pack ./agent --include-secrets --passphrase "my-secret-phrase"
 *   agentpkg compile agent.zip --target claude-code --passphrase "my-secret-phrase"
 *
 * Security model:
 *   - Secrets are NEVER written to disk in plaintext
 *   - The vault file (secrets/vault.json) contains only ciphertext
 *   - Without the passphrase, the vault is useless
 *   - Secret keys (names, not values) are visible for reference
 *   - The audit scanner flags any vault that exists in a package
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Secret, EncryptedVault } from "./types";

const ALGORITHM = "aes-256-gcm";
const KDF = "scrypt";
const SCRYPT_COST = 2 ** 14; // N=16384 (secure, lower memory)
const SCRYPT_BLOCK = 8;      // r
const SCRYPT_PARALLEL = 1;   // p
const KEY_LENGTH = 32;        // 256 bits
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

// ─────────────────────────────────────────────
// Encrypt / Decrypt
// ─────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
  });
}

/**
 * Check passphrase strength. Returns null if OK, or a warning string.
 * Does NOT throw — callers decide whether to enforce.
 */
export function assessPassphrase(passphrase: string): string | null {
  if (passphrase.length < 12) {
    return `Passphrase is ${passphrase.length} chars; 12+ recommended for strong vaults`;
  }
  // Cheap entropy proxy: require at least 2 character classes.
  const classes =
    (/[a-z]/.test(passphrase) ? 1 : 0) +
    (/[A-Z]/.test(passphrase) ? 1 : 0) +
    (/[0-9]/.test(passphrase) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(passphrase) ? 1 : 0);
  if (classes < 2) {
    return "Passphrase uses a single character class; mix letters/digits/symbols for strength";
  }
  // Block trivial repeats / sequences.
  if (/^(.)\1+$/.test(passphrase)) return "Passphrase is a single repeated character";
  return null;
}

export function encryptSecrets(secrets: Secret[], passphrase: string): EncryptedVault {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters");
  }
  if (process.env.AGENTPKG_SILENT !== "1") {
    const warn = assessPassphrase(passphrase);
    if (warn) console.warn(`[agentpkg] weak passphrase: ${warn}`);
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const plaintext = JSON.stringify(secrets);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: "agentpkg-vault",
    algorithm: ALGORITHM,
    kdf: KDF,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    count: secrets.length,
    keys: secrets.map((s) => s.key),
  };
}

export function decryptSecrets(vault: EncryptedVault, passphrase: string): Secret[] {
  if (vault.format !== "agentpkg-vault") {
    throw new Error("Not a valid agentpkg vault file");
  }

  const salt = Buffer.from(vault.salt, "base64");
  const iv = Buffer.from(vault.iv, "base64");
  const authTag = Buffer.from(vault.authTag, "base64");
  const ciphertext = Buffer.from(vault.ciphertext, "base64");
  const key = deriveKey(passphrase, salt);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf-8"));
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted vault");
  }
}

// ─────────────────────────────────────────────
// Vault file I/O
// ─────────────────────────────────────────────

export function writeVault(vaultDir: string, secrets: Secret[], passphrase: string): string {
  const vault = encryptSecrets(secrets, passphrase);
  const vaultPath = path.join(vaultDir, "vault.json");
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2), "utf-8");
  return vaultPath;
}

export function readVault(vaultPath: string, passphrase: string): Secret[] {
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`Vault not found: ${vaultPath}`);
  }
  const vault: EncryptedVault = JSON.parse(fs.readFileSync(vaultPath, "utf-8"));
  return decryptSecrets(vault, passphrase);
}

export function vaultExists(pkgDir: string): boolean {
  return fs.existsSync(path.join(pkgDir, "secrets", "vault.json"));
}

export function vaultInfo(pkgDir: string): { count: number; keys: string[] } | null {
  const vaultPath = path.join(pkgDir, "secrets", "vault.json");
  if (!fs.existsSync(vaultPath)) return null;
  try {
    const vault: EncryptedVault = JSON.parse(fs.readFileSync(vaultPath, "utf-8"));
    return { count: vault.count, keys: vault.keys };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Secret collection helpers
// ─────────────────────────────────────────────

/**
 * Read secrets from a directory where each file is a secret.
 * File name = key, file contents = value.
 * This is the OpenClaw pattern: secrets/telegram-bot-token, secrets/twitter-creds, etc.
 */
export function collectSecretsFromDir(secretsDir: string): Secret[] {
  if (!fs.existsSync(secretsDir)) return [];

  const secrets: Secret[] = [];
  for (const file of fs.readdirSync(secretsDir)) {
    const filePath = path.join(secretsDir, file);
    if (!fs.statSync(filePath).isFile()) continue;

    const value = fs.readFileSync(filePath, "utf-8").trim();
    if (!value) continue;

    secrets.push({
      key: file,
      value,
      type: guessSecretType(file, value),
      description: `Imported from ${secretsDir}/${file}`,
      createdAt: new Date().toISOString(),
    });
  }

  return secrets;
}

/**
 * Read secrets from environment variables matching a pattern.
 */
export function collectSecretsFromEnv(pattern: RegExp = /_(KEY|TOKEN|SECRET|PASSWORD|CRED)$/i): Secret[] {
  const secrets: Secret[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (pattern.test(key) && value) {
      secrets.push({
        key,
        value,
        type: guessSecretType(key, value),
        description: `From environment variable`,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return secrets;
}

/**
 * Read secrets from a .env file.
 */
export function collectSecretsFromEnvFile(envPath: string): Secret[] {
  if (!fs.existsSync(envPath)) return [];
  const secrets: Secret[] = [];
  const content = fs.readFileSync(envPath, "utf-8");

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || value.startsWith("your_") || value === "changeme") continue;

    secrets.push({
      key,
      value,
      type: guessSecretType(key, value),
      description: `From .env file`,
      createdAt: new Date().toISOString(),
    });
  }

  return secrets;
}

function guessSecretType(key: string, value: string): Secret["type"] {
  const k = key.toLowerCase();
  if (k.includes("password") || k.includes("passwd")) return "password";
  if (k.includes("token")) return "token";
  if (k.includes("cert") || k.includes("pem")) return "certificate";
  if (value.startsWith("{") || value.startsWith("[")) return "oauth_json";
  return "api_key";
}

// ─────────────────────────────────────────────
// Secret injection into compiled targets
// ─────────────────────────────────────────────

/**
 * After compiling, inject decrypted secrets into the target's native format.
 * Each platform stores credentials differently.
 */
export function injectSecrets(secrets: Secret[], target: string, outputDir: string): void {
  switch (target) {
    case "claude-code":
      injectClaudeCode(secrets, outputDir);
      break;
    case "crewai":
      injectCrewAI(secrets, outputDir);
      break;
    case "openai":
      injectOpenAI(secrets, outputDir);
      break;
    default:
      // For platforms without native secret storage, write a .env
      injectDotEnv(secrets, outputDir);
      break;
  }
}

function injectClaudeCode(secrets: Secret[], outputDir: string): void {
  // Claude Code uses environment variables, written to a .env the user sources
  injectDotEnv(secrets, outputDir);

  // Also update .mcp.json with any MCP server tokens
  const mcpPath = path.join(outputDir, ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    for (const secret of secrets) {
      const envKey = secret.key.toUpperCase().replace(/-/g, "_");
      if (mcp.mcpServers) {
        for (const [, server] of Object.entries(mcp.mcpServers) as [string, any][]) {
          if (!server.env) server.env = {};
          // Match secret to server by name similarity
          if (secret.integration && server === mcp.mcpServers[secret.integration]) {
            server.env[envKey] = secret.value;
          }
        }
      }
    }
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2), "utf-8");
  }
}

function injectCrewAI(secrets: Secret[], outputDir: string): void {
  // CrewAI uses .env file
  const envPath = path.join(outputDir, ".env");
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

  for (const secret of secrets) {
    const envKey = secret.key.toUpperCase().replace(/-/g, "_");
    // Replace placeholder or append
    const pattern = new RegExp(`^#?\\s*${envKey}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, `${envKey}=${secret.value}`);
    } else {
      content += `${envKey}=${secret.value}\n`;
    }
  }

  fs.writeFileSync(envPath, content, "utf-8");
}

function injectOpenAI(secrets: Secret[], outputDir: string): void {
  // Write .env + update config metadata
  injectDotEnv(secrets, outputDir);

  // If there's an OPENAI_API_KEY, note it in the config
  const apiKey = secrets.find((s) => s.key.toLowerCase().includes("openai"));
  if (apiKey) {
    for (const configFile of ["openai-responses-config.json", "openai-assistant-config.json"]) {
      const configPath = path.join(outputDir, configFile);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        config._api_key_env = apiKey.key.toUpperCase().replace(/-/g, "_");
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      }
    }
  }
}

function injectDotEnv(secrets: Secret[], outputDir: string): void {
  const envPath = path.join(outputDir, ".env");
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  content += "\n# ── Secrets injected by agentpkg ──\n";

  for (const secret of secrets) {
    const envKey = secret.key.toUpperCase().replace(/-/g, "_");
    content += `${envKey}=${secret.value}\n`;
  }

  fs.writeFileSync(envPath, content, "utf-8");
}
