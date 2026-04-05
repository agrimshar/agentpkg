# External Integrations

**Analysis Date:** 2026-04-05

## Overview

This codebase does not directly integrate with external services. Instead, it provides a **packaging and compilation framework** for agent definitions that may use integrations. The package itself is a meta-tool that describes, validates, and compiles agents that could target various platforms and services.

## Supported Integration Types

**Integration types are defined in type system** (`src/types.ts`):
- `"mcp"` - Model Context Protocol servers
- `"api"` - REST/HTTP APIs
- `"webhook"` - Webhook endpoints (incoming/outgoing)
- `"oauth"` - OAuth 2.0 providers
- `string` - Custom integration types

**Integration structure** (`src/index.ts:289-304`):
```typescript
addIntegration(opts: {
  name: string;           // Integration identifier
  type: string;           // "mcp" | "api" | "webhook" | "oauth" | custom
  url?: string;           // Endpoint or MCP server URL
  config?: Record<...>;   // Platform-specific configuration
  scopes?: string[];      // OAuth scopes or permissions
}): this
```

## Credential Management

**No direct external authentication.** Secrets are stored encrypted within agent packages:

**Location:** `src/secrets.ts`

**Encryption:**
- Algorithm: AES-256-GCM
- KDF: scrypt (N=16384, r=8, p=1)
- Security model:
  - Secrets encrypted on disk in `secrets/vault.json`
  - Plaintext only in memory when decrypted
  - Requires passphrase to decrypt
  - Secret keys (not values) visible for reference without decryption

**Credential Types** (`src/types.ts:256`):
- `"api_key"` - API keys for REST services
- `"token"` - Bearer/access tokens
- `"password"` - Basic auth passwords
- `"oauth_json"` - OAuth credential JSON (service account keys)
- `"certificate"` - PEM certificates
- `"other"` - Custom credential types

**Known credential mappings** (for OpenClaw adapter, `src/adapters/openclaw.ts:36-44`):
- `telegram-bot-token` → `webhook` / `telegram`
- `twitter-creds` → `oauth` / `twitter`
- `bluesky-app-password` → `api` / `bluesky`
- `beehiiv-api-key` → `api` / `beehiiv`
- `gmail-app-password` → `api` / `gmail`
- `cloudflare-api-token` → `api` / `cloudflare`
- `hooks-token` → `webhook` / `hooks`

## Data Storage

**No persistent database.** This is a file-based system:

**Optional SQLite Support:**
- For OpenClaw agent memory extraction (`src/adapters/openclaw.ts:105-107`)
- Package: `better-sqlite3` (optional, installed on-demand)
- Usage: Reads SQLite memory databases from OpenClaw workspace
- Fallback: If `better-sqlite3` not available, references databases without extraction
- Error handling: Graceful degradation if SQLite reading fails

**File-based storage:**
- Agent manifests: JSON files in unpacked directories
- Knowledge documents: Stored as files within package
- Memories: Either JSON entries or SQLite databases (from source systems)

## Knowledge Source Adapters

**OpenClaw Adapter** (`src/adapters/openclaw.ts`):
- Reads live OpenClaw filesystem directory
- Extracts:
  - Soul/identity from `workspace/*.md` files
  - Memories from `memory/` SQLite databases (if extractable) and `workspace/memory/` markdown
  - Skills from `workspace/skills/`
  - Cron jobs from `cron/jobs.json`
  - Subagents from `agents/`
  - Integration configs from `secrets/` and `credentials/`
  - Knowledge from workspace documentation
  - Media assets (optional)

**Input Handling:**
- Reads `openclaw.json` configuration file
- Parses workspace markdown files
- Accesses filesystem directly (no API)
- Optional SQLite extraction via `better-sqlite3`

## Compilation Targets

The compiler generates agent code for multiple platforms, each with their own integration approaches:

**Platform: Claude Code** (`src/compile.ts:99-177`)
- Format: `.claude/` directory structure + `CLAUDE.md` + `.mcp.json`
- Integration support:
  - `.claude/mcp.json` - MCP server configuration
  - Skills defined in `.claude/skills/`
  - Tools listed in skill definitions

**Platform: Cursor** (`src/compile.ts:179-241`)
- Format: `.cursor/rules/` with `.mdc` files
- Integration support: Referenced in project rules

**Platform: Copilot (GitHub)** (`src/compile.ts:243-311`)
- Format: `.github/copilot-instructions.md`
- Integration support: Via tool descriptions in instructions

**Platform: Windsurf** (`src/compile.ts:313-365`)
- Format: `.windsurf/rules/` and legacy `.windsurfrules`
- Integration support: Similar to cursor approach

**Platform: CrewAI (Python)** (`src/compile.ts:367-447`)
- Format: Python project structure with `src/`, `config/`, `tools/`
- Integration support:
  - Tools as `BaseTool` classes
  - Agent configuration with `agentpkg` project type marker
  - Dependencies: `crewai[tools]>=0.100.0`
  - Python requirement: `>=3.10,<3.13`

**Platform: OpenAI** (`src/compile.ts:449-517`)
- Format: Assistant and Responses API configs
- Integration support:
  - OpenAI Assistants API v2 configuration JSON
  - OpenAI Responses API configuration JSON
  - Environment variable support for API keys

**Platform: APM (Agent Protocol Manager)** (`src/compile.ts:519-605`)
- Format: `apm.yml` + directory structure
- Integration support: YAML-based agent definitions with tool/skill mappings

## Security Auditing

**Audit engine** (`src/audit.ts`):

Detects suspicious patterns in agent code:
- **Hidden Unicode:** Zero-width characters, bidirectional overrides, tag characters
- **Prompt Injection:** "Ignore previous instructions", jailbreak patterns, encoded instruction markers
- **Suspicious Tools:** Credential harvesting, data exfiltration endpoints, localhost callbacks, unknown webhooks, shell execution

Severity levels: `critical`, `high`, `medium`, `low`

Audit function `auditDirectory()` and `auditZip()` scan for these threats before packaging.

## Dependencies Management

**Dependency resolution system** (`src/deps.ts`):

**Supported dependency sources:**
- `npm:` - npm registry packages
- `git:` - Git repositories with optional `#ref` branch/tag
- `local:` - Local filesystem paths
- `url:` - HTTP(S) URLs to archives

**Lockfile mechanism:**
- File: `agentpkg.lock.json` (git-tracked)
- Records resolved versions and checksums
- Tracks dependency tree for transitive dependency resolution

**Depth limits:**
- Maximum nesting: 20 levels (prevents infinite recursion)
- Circular dependency detection via depth counter

## Webhooks & Callbacks

**Webhook detection** (audit pattern, `src/audit.ts:46`):
- Warns on webhooks to unknown hosts (except Slack, Discord, GitHub, GitLab)
- Pattern: `webhook.*https?://` matching against known safe hosts
- Severity: medium

**Integration webhook support** (`src/types.ts:85`):
- Type: `"webhook"`
- Stored with name and URL in integration config
- Can have scopes/permissions metadata

## Environment Configuration

**Secret injection** (`src/secrets.ts:290-310`):
- OpenAI API key detection and environment variable mapping
- Automatic conversion of secret key to uppercase with underscore normalization
- Example: `openai-api-key` secret → `OPENAI_API_KEY` env var

**No hardcoded credentials:**
- All secrets required at runtime via passphrase-protected vault
- Secrets never persisted in plaintext
- Secret metadata (names, not values) always visible in `keys[]` array

## Known Integrations Not Directly Used

This codebase **does not directly use**:
- HTTP clients (no `fetch`, `axios`, `requests`)
- Database drivers (except optional `better-sqlite3`)
- Cloud SDKs (AWS, Azure, GCP)
- API clients (Slack, Discord, etc.)
- Message queues
- Cache systems
- Monitoring/observability services

All integration is **handled by the packaged agents** when compiled to target platforms.

---

*Integration audit: 2026-04-05*
