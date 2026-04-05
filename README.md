# agentpkg

Universal packaging format for AI agents. Bundle an agent's soul, memories, skills, tools, crons, subagents, workflows, integrations, and encrypted secrets into a single portable `.agentpkg.zip` — then compile it to any platform's native directory structure.

```
agentpkg pack ./my-agent --passphrase "migrate-key"
agentpkg compile agent.agentpkg.zip --target claude-code --passphrase "migrate-key"
```

## Why

AI agents are trapped in their platforms. Your OpenClaw agent can't move to Claude Code. Your Cursor rules don't work in Copilot. Your CrewAI agents can't become Windsurf rules. agentpkg fixes this by defining a single interchange format and compiling to every target's real file structure.

## Install

```bash
npm install -g agentpkg
```

Requires Node.js 18+. Zero runtime dependencies.

## Quick start

```bash
# Create a new agent package
agentpkg init my-agent

# Edit the files in my-agent.agentpkg/
# Then pack it
agentpkg pack my-agent.agentpkg

# Compile to Claude Code
agentpkg compile my-agent.agentpkg.zip --target claude-code -o ./output

# Compile to ALL platforms at once
agentpkg compile my-agent.agentpkg.zip --target all -o ./output
```

## What's in a package

An `.agentpkg.zip` contains:

```
my-agent.agentpkg/
├── manifest.json              # Package metadata
├── soul/
│   ├── system-prompt.md       # The agent's system prompt
│   ├── identity.json          # Model config (model, temperature, etc.)
│   └── guardrails.json        # Rules, refusals, safety notes
├── memories/
│   ├── index.json
│   └── entries/*.json         # Individual memory entries with type + importance
├── skills/
│   └── skill-name/
│       ├── skill.json         # Metadata
│       ├── SKILL.md           # Instructions
│       └── handler.js         # Optional handler code
├── tools/
│   └── tool-name/
│       ├── tool.json          # Schema + parameters
│       └── handler.py         # Optional handler
├── crons/
│   └── schedules.json         # Cron jobs with schedules
├── subagents/
│   └── sub-agent.agentpkg/    # Recursively nested packages
├── workflows/
│   └── workflow-name.json     # Multi-step workflows
├── integrations/
│   └── connections.json       # MCP servers, APIs, webhooks
├── knowledge/
│   ├── documents/*.md         # Reference documents
│   └── structured/*.json      # Structured data
├── secrets/
│   └── vault.json             # AES-256-GCM encrypted credentials
└── meta/
    ├── platform-raw/          # Original platform export (lossless)
    └── export-log.json
```

## Compile targets

Each target generates the platform's real native directory structure:

| Target | Command | What it generates |
|---|---|---|
| **Claude Code** | `--target claude-code` | `CLAUDE.md` + `.claude/{settings.json, skills/*/SKILL.md, agents/*.md, commands/*.md, rules/*.md}` + `.mcp.json` |
| **Cursor** | `--target cursor` | `.cursor/rules/*.mdc` (with `description`/`globs`/`alwaysApply` frontmatter) + `AGENTS.md` |
| **GitHub Copilot** | `--target copilot` | `.github/{copilot-instructions.md, instructions/*.instructions.md, agents/*.md, skills/*/SKILL.md, prompts/*.prompt.md}` + `AGENTS.md` |
| **Windsurf** | `--target windsurf` | `.windsurf/rules/*.md` + `.windsurfrules` + `AGENTS.md` |
| **CrewAI** | `--target crewai` | Full Python project: `pyproject.toml` + `src/*/config/{agents.yaml, tasks.yaml}` + `crew.py` + `tools/*.py` + `.env` |
| **OpenAI** | `--target openai` | `openai-responses-config.json` (Responses API) + `openai-assistant-config.json` (legacy) |
| **Microsoft APM** | `--target apm` | `apm.yml` + `.apm/{agents/*.agent.md, instructions/*.instructions.md, skills/*/SKILL.md, prompts/*.prompt.md}` + `AGENTS.md` + `CLAUDE.md` |

## Encrypted secrets

Secrets are encrypted with AES-256-GCM and scrypt key derivation. Without the passphrase, the vault is cryptographic noise.

```bash
# Pack with secrets
agentpkg pack ./my-agent --passphrase "my-secret-phrase"

# Inspect shows key names without decrypting
agentpkg inspect agent.agentpkg.zip
#   Secrets          3 (encrypted)
#   ℹ Secret keys in vault:
#     - SLACK_BOT_TOKEN
#     - OPENAI_API_KEY
#     - DATABASE_URL

# Compile and inject secrets into target platform
agentpkg compile agent.zip --target claude-code --passphrase "my-secret-phrase"
# → .env created with decrypted credentials
# → .mcp.json updated with tokens
```

Each platform gets secrets in its native format:

| Platform | Where secrets go |
|---|---|
| Claude Code | `.env` + `.mcp.json` env fields |
| CrewAI | `.env` (environment variables) |
| OpenAI | `.env` + config metadata |
| Others | `.env` file |

## Import from any source

### Generic JSON

```bash
# Convert any agent export JSON to agentpkg
agentpkg convert export.json --platform relevance-ai -o agent.agentpkg.zip
```

The fuzzy adapter matches common key patterns: `systemPrompt`/`persona`/`soul`/`character` → system prompt, `memories`/`context`/`knowledge_base` → memories, etc.

### OpenClaw (dedicated adapter)

```typescript
import { convertOpenClaw } from "agentpkg/adapters/openclaw";

const pkg = convertOpenClaw("~/.config/openclaw", {
  includeSecrets: true,    // Collect actual credential values
  extractSqliteMemories: true,  // Read all 8 SQLite databases
});

await pkg.pack("my-agent.agentpkg.zip", "migration-passphrase");
```

The OpenClaw adapter reads: `SOUL.md` + `IDENTITY.md` → soul, 8 SQLite databases → memories, `workspace/memory/*.md` → typed memories, `workspace/skills/` → skills with reference docs, `cron/jobs.json` → crons, `agents/{cap,hype,spore,myco,ticker,web,roots}/` → 7 subagents, `secrets/` → encrypted vault.

## Programmatic API

```typescript
import { AgentPackage } from "agentpkg";
import { compile } from "agentpkg/compile";

const pkg = new AgentPackage({
  name: "Research Assistant",
  description: "AI research agent",
});

pkg.setSoul(
  "You are an AI research assistant specializing in ML papers.",
  { model: "claude-sonnet-4-20250514", temperature: 0.3 },
  { rules: ["Always cite sources"], refusals: [], safetyNotes: [] }
);

pkg.addMemory({ id: "m1", content: "User studies RLHF", type: "preference", importance: 0.9 });
pkg.addSkill({ name: "arxiv-monitor", description: "Monitor arxiv", instructions: "# Arxiv\n..." });
pkg.addTool({ name: "search", description: "Search KB", parameters: { type: "object" } });
pkg.addCron({ name: "daily-digest", schedule: "0 8 * * *", action: "Run digest" });
pkg.addIntegration({ name: "slack", type: "mcp", url: "https://slack.mcp.example.com/sse" });
pkg.addSecret({ key: "SLACK_TOKEN", value: "xoxb-...", type: "token", integration: "slack" });

const sub = new AgentPackage({ name: "citation-bot" });
sub.setSoul("Format citations in BibTeX, APA, MLA.");
pkg.addSubagent(sub);

// Pack with encrypted secrets
await pkg.pack("research-assistant.agentpkg.zip", "my-passphrase");

// Compile to any target
compile(pkg, "claude-code", "./output");
compile(pkg, "crewai", "./output");
compile(pkg, "copilot", "./output");
```

## CLI reference

```
agentpkg init <name>               Scaffold a new agent package
agentpkg pack <dir>                Pack into .agentpkg.zip
agentpkg validate <path>           Validate package structure
agentpkg inspect <path>            Show contents + secrets summary
agentpkg unpack <zip>              Extract a package
agentpkg convert <json>            Convert any JSON to agentpkg
agentpkg audit <path>              Security scan
agentpkg compile <path>            Compile to platform format
```

### Flags

```
--target <format>         Compile target (claude-code|cursor|copilot|windsurf|crewai|openai|apm|all)
--passphrase <phrase>     Encrypt/decrypt secrets vault (AES-256-GCM + scrypt)
--include-secrets         Include credential values when importing
--platform <name>         Source platform name for convert command
-o <path>                 Output path
```

## Security audit

The audit scanner checks for 26 threat patterns across three categories:

```bash
agentpkg audit agent.agentpkg.zip
```

- **Hidden unicode** (12 patterns): zero-width characters, RTL overrides, tag characters
- **Prompt injection** (7 patterns): instruction overrides, jailbreak attempts, encoded payloads
- **Suspicious tools** (7 patterns): credential harvesting, data exfiltration endpoints, shell execution

## Project structure

```
src/
├── types.ts              285 lines    All interfaces and type definitions
├── index.ts              853 lines    AgentPackage class, validator, JSON adapter
├── compile.ts            637 lines    7 compile targets with native directory structures
├── secrets.ts            320 lines    AES-256-GCM encrypted vault with scrypt KDF
├── audit.ts              155 lines    Security scanner
├── deps.ts               192 lines    Dependency resolver with lockfile
└── adapters/
    └── openclaw.ts       669 lines    Dedicated OpenClaw filesystem adapter
bin/
└── cli.ts                297 lines    CLI with 8 commands
test/
└── test.js               307 lines    20 tests
```

3,408 lines of TypeScript. Zero runtime dependencies. 20 tests.

## Contributing

```bash
git clone https://github.com/yourusername/agentpkg.git
cd agentpkg
npm install
npm test        # 20 tests
npm run build   # TypeScript → dist/
```

## License

MIT
