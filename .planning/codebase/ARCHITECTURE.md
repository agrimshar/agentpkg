# Architecture

**Analysis Date:** 2026-04-05

## Pattern Overview

**Overall:** Multi-stage transformation pipeline with modular compilation targets

**Key Characteristics:**
- **Package-centric design**: All agent state converges into `AgentPackage` abstraction before export/compilation
- **Format conversion hub**: Accepts multiple import sources (JSON, zip, OpenClaw filesystem) and outputs to 7 platform targets
- **Encryption-by-default secrets**: Secrets stored in encrypted vault within packages, never written plaintext
- **Portable ZIP format**: Single `.agentpkg.zip` archive contains complete agent definition, compilable to any target platform
- **No runtime dependencies**: Pure Node.js with stdlib (`fs`, `crypto`, `path`, `child_process`)

## Layers

**Data Model Layer:**
- Purpose: Define canonical agent representation
- Location: `types.ts`
- Contains: TypeScript interfaces for all agent components (Identity, Memory, Skill, Tool, CronJob, Workflow, Integration, etc.), audit types, dependency specs, compile targets
- Depends on: Nothing
- Used by: All other modules

**Core Package Layer:**
- Purpose: In-memory representation and manipulation of agent packages
- Location: `index.ts` - `AgentPackage` class (~600 lines)
- Contains: 
  - Builder methods: `addMemory()`, `addSkill()`, `addTool()`, `addCron()`, `addWorkflow()`, `addIntegration()`, etc.
  - Serialization: `writeToDir()`, `pack()` (creates ZIP with manifest)
  - Deserialization: `fromDir()`, `fromZip()`, `fromJSON()`
  - Validation and manifest generation
  - Soul (system prompt + identity config) management
  - Asset/binary file handling
  - Platform raw metadata preservation
- Depends on: `types.ts`, Node.js stdlib
- Used by: CLI, compilation layer, adapters

**Compilation Layer:**
- Purpose: Transform AgentPackage into platform-specific directory structures
- Location: `compile.ts`
- Contains: 
  - 7 compiler functions: `compileClaudeCode()`, `compileCursor()`, `compileCopilot()`, `compileWindsurf()`, `compileCrewAI()`, `compileOpenAI()`, `compileAPM()`
  - Each compiler generates native .claude/, .cursor/, .copilot/, etc. directory trees following official platform docs
  - Helper functions: memory blocks, guardrail blocks, skill/tool documentation
  - `compile()` single-target, `compileAll()` batch operation
- Depends on: `AgentPackage`, Node.js stdlib
- Used by: CLI, library consumers

**Secrets Layer:**
- Purpose: Encrypt/decrypt secrets using AES-256-GCM
- Location: `secrets.ts`
- Contains:
  - Encryption: `encryptSecrets()` with scrypt key derivation
  - Decryption: `decryptSecrets()` with passphrase
  - Vault file ops: `writeVault()`, `readVault()`, `vaultInfo()`
  - Secret collection: `collectSecretsFromDir()`, `collectSecretsFromEnv()`, `collectSecretsFromEnvFile()`
  - Secret injection: `injectSecrets()` (writes platform-specific secret files)
- Depends on: `types.ts`, Node.js crypto module
- Used by: Core package layer, CLI

**Audit Layer:**
- Purpose: Security scanning for hidden unicode, prompt injection, suspicious tools
- Location: `audit.ts`
- Contains:
  - Threat pattern definitions (hidden unicode, prompt injection, credential harvesting, shell execution)
  - `AuditResult` class with finding aggregation and severity categorization
  - `auditFile()`, `auditDirectory()`, `auditZip()` scanning functions
  - Severity levels: critical, high, medium, low
- Depends on: `types.ts`, Node.js stdlib
- Used by: CLI validation, integration checks

**Dependency Management Layer:**
- Purpose: Parse, lock, and resolve dependencies (git, npm, local, url)
- Location: `deps.ts`
- Contains:
  - `parseDep()` converts strings like "npm:lodash@4.17" or "git:https://repo#main" to structured specs
  - `Lockfile` class manages `agentpkg.lock.json` with resolved dependency versions
  - `DependencyResolver` class for resolving and tracking transitive dependencies
- Depends on: `types.ts`, Node.js stdlib
- Used by: Package builder, CLI

**Adapter Layer:**
- Purpose: Convert platform-specific exports into canonical AgentPackage
- Location: `openclaw.ts`, `index.ts:convertFromJSON()`
- Contains:
  - `convertOpenClaw()` reads OpenClaw filesystem structure and extracts souls, memories, skills, crons, secrets, subagents
  - `convertFromJSON()` normalizes arbitrary JSON exports using key aliases (handles variations in naming)
  - Platform-raw metadata preservation for lossless round-trip
- Depends on: `AgentPackage`, Node.js stdlib
- Used by: CLI import commands

**CLI/Orchestration Layer:**
- Purpose: User-facing command interface
- Location: `cli.ts`
- Contains: Commands:
  - `init` - scaffold new agent package
  - `pack` - bundle directory to ZIP with optional secret encryption
  - `compile` - transform ZIP to target platform(s)
  - `validate` - check package integrity
  - `audit` - security scan
  - `vault` - manage secrets
  - Color-coded output formatting
- Depends on: All other layers
- Used by: Binary entry point (`agentpkg` command)

## Data Flow

**Packing Flow (Directory → ZIP):**

1. CLI invokes `AgentPackage.fromDir(dirPath)` 
2. `fromDir()` recursively loads:
   - `manifest.json` → agent identity, metadata
   - `soul/system-prompt.md` → system prompt
   - `soul/identity.json` → model config
   - `soul/guardrails.json` → rules/refusals
   - `memories/entries/*.json` → memory array
   - `skills/*/skill.json + SKILL.md` → skill definitions with docs
   - `tools/*/tool.json` → tool specifications
   - `crons/schedules.json` → cron job array
   - `integrations/connections.json` → integration configs
   - `knowledge/documents/` and `knowledge/structured/` → knowledge docs
   - `workflows/*.json` → workflow definitions
   - `subagents/*/` → nested AgentPackage instances
   - `meta/platform-raw/*.json` → original platform export (for preservation)
3. Secrets collected from `secrets/` directory or environment
4. `pkg.pack(outputPath, passphrase)` called:
   - Creates ZIP archive containing all state
   - Generates manifest with content counts
   - If passphrase provided: calls `encryptSecrets()`, writes `secrets/vault.json` to ZIP
   - Computes SHA256 checksum of ZIP
   - Returns `PackResult { path, size, checksum }`

**Compilation Flow (ZIP → Platform-Specific):**

1. CLI invokes `compileAll(pkg, outputDir)` or `compile(pkg, targetName, outputDir)`
2. ZIP loaded: `AgentPackage.fromZip(zipPath)` decompresses and loads package state
3. If passphrase provided: `readVault(vaultPath, passphrase)` decrypts secrets
4. Platform-specific compiler invoked:
   - Each compiler reads pkg's soul, memories, skills, tools, integrations
   - Generates native directory structure (e.g., `.claude/`, `.cursor/`, etc.)
   - Writes platform-specific config files (e.g., `CLAUDE.md`, `cursor.config.json`)
   - Creates README documents with agent persona, key memories, skills, tool catalog
   - Injects secrets via `injectSecrets()` (writes to platform-specific secret file locations)
   - Returns `CompileResult { dir, files, size }`
5. Result written to `outputDir/[target-name]/`

**Validation Flow (Dirpath or ZIP):**

1. CLI invokes `validate(dirPath)` or `validateZip(zipPath)`
2. Checks manifest structure
3. Verifies required soul files exist
4. Counts and validates memory entries
5. Validates skill/tool JSON schemas
6. Scans for hidden characters/encoding issues
7. Returns `ValidationResult { valid, errors[], warnings[], info[] }`

**Audit Flow (Security Scan):**

1. CLI invokes `auditDirectory(basePath)` or `auditZip(zipPath)`
2. Scans all text files for threat patterns
3. For each match, creates `AuditFinding` with:
   - Severity level (critical/high/medium/low)
   - Category (hidden-unicode, prompt-injection, suspicious-tool)
   - File path and line number
   - Code snippet
4. Aggregates into `AuditResult` with summary statistics
5. Returns findings grouped by severity

**State Management:**

- **In-memory state**: `AgentPackage` class holds all agent definition in memory during CLI operations
- **Serialization**: `AgentPackage` → JSON files in `.agentpkg/` directory structure during `pack()`
- **Encryption**: Secrets encrypted with passphrase before ZIP creation, never written plaintext
- **Format**: ZIP archive format chosen for portability and multi-file compression
- **Manifest**: Single source of truth for package metadata, stored in `manifest.json` inside ZIP

## Key Abstractions

**AgentPackage:**
- Purpose: Canonical in-memory representation of a complete AI agent with all components
- Examples: `index.ts:100-607` (class definition)
- Pattern: Builder pattern with chainable add* methods; implements serialization to/from multiple formats (directory, ZIP, JSON)

**Manifest:**
- Purpose: Package metadata and contents inventory
- Examples: `types.ts:101-133`
- Pattern: Generated on pack, contains format version, agent identity, content counts, dependency declarations

**Encrypted Vault:**
- Purpose: AES-256-GCM encrypted container for secrets
- Examples: `types.ts:265-284`, `secrets.ts:45-70`
- Pattern: KDF (scrypt) + authenticated encryption, vault metadata stores secret keys (not values) for safe reference

**Compiler Functions:**
- Purpose: Platform-specific directory structure generation
- Examples: `compile.ts:17-25` (compiler registry), individual compiler functions
- Pattern: Each compiler follows official documentation, generates README + config files + embedded agent soul

**Audit Result:**
- Purpose: Security finding aggregation and reporting
- Examples: `audit.ts:56-99` (AuditResult class)
- Pattern: Collects findings during scan, groups by severity, provides pass/fail summary

## Entry Points

**CLI Entry Point:**
- Location: `cli.ts` (shebang: `#!/usr/bin/env node`)
- Triggers: User executes `agentpkg <command> [args]`
- Responsibilities: Parse argv, dispatch to command handlers (init, pack, compile, validate, audit, vault info), format/colorize output, exit with status codes

**Library Entry Point:**
- Location: `index.ts` (exported as `.` in package.json exports)
- Triggers: `import { AgentPackage } from 'agentpkg'` or `import { compile } from 'agentpkg/compile'`
- Responsibilities: Expose public API (AgentPackage class, validation, conversion functions, types)

**Compiler Entry Point:**
- Location: `compile.ts` (exported as `./compile` in package.json exports)
- Triggers: `import { compile, compileAll } from 'agentpkg/compile'`
- Responsibilities: Transform AgentPackage to target platform structures

**Secrets Entry Point:**
- Location: `secrets.ts` (exported as `./secrets` in package.json exports)
- Triggers: `import { encryptSecrets, decryptSecrets } from 'agentpkg/secrets'`
- Responsibilities: Manage encrypted vault operations, secret injection

**Audit Entry Point:**
- Location: `audit.ts` (exported as `./audit` in package.json exports)
- Triggers: `import { auditDirectory } from 'agentpkg/audit'`
- Responsibilities: Security scanning and threat detection

## Error Handling

**Strategy:** Synchronous exceptions for validation errors, async for I/O errors. Errors surface to CLI with colored output and helpful messages.

**Patterns:**
- **Validation errors**: Throw immediately if required files missing or JSON invalid (e.g., `throw new Error("manifest.json not found")`)
- **I/O errors**: Let fs/execSync exceptions propagate, caught in CLI try-catch blocks
- **Compilation failures**: Return `CompileResult { error: string }` to avoid blocking batch operations
- **Passphrase errors**: Throw on decryption failure (wrong passphrase, corrupt vault)
- **Audit findings**: Collect, never throw (security scan is non-blocking)

## Cross-Cutting Concerns

**Logging:** 
- CLI uses colored console output (`\x1b[` ANSI codes)
- Success/warn/error/info functions format messages with symbols and colors
- No silent mode; all operations print progress

**Validation:** 
- Manifest validation: `validate()` checks directory structure, file presence, JSON validity
- Schema validation: Implicit via TypeScript types; no runtime schema validators
- Zip validation: `validateZip()` temporarily extracts and validates contents

**Authentication:** 
- Passphrase-based encryption for secrets (scrypt KDF, 14-bit cost)
- No user authentication; packages are portable files
- Passphrase required only for: packing (to encrypt secrets) and compiling (to decrypt vault)

**Platform Compatibility:**
- Cross-platform: Uses `path.join()` and fs operations that work on Win/Mac/Linux
- Compression fallback: zip → tar.gz → error if neither available
- Executable: CLI binary works on any Node 18+ environment

---

*Architecture analysis: 2026-04-05*
