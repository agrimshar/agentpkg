# agentpkg

One format for all your AI agents. Write your agent once, then compile it to Claude Code, Cursor, Copilot, Windsurf, CrewAI, OpenAI, or APM.

```
agentpkg pack ./my-agent
agentpkg compile agent.agentpkg.zip --target claude-code
```

## The Problem

AI agents are locked into whatever platform built them. Your Claude Code agent can't move to Cursor. Your Cursor rules don't work in Copilot. Your CrewAI agents can't become Windsurf rules.

agentpkg solves this. You define your agent once (its personality, memories, skills, tools, secrets, everything) and agentpkg compiles it into the exact file structure each platform expects.

## Install

```bash
npm install -g universal-agent
```

Needs Node.js 18+. Zero runtime dependencies. The CLI command is still `agentpkg`.

## Tutorial: Your First Agent in 5 Minutes

### Step 1: Create a new agent

```bash
agentpkg init my-agent
```

This creates a `my-agent.agentpkg/` folder with a starter template.

### Step 2: Customize your agent

Open `my-agent.agentpkg/soul/system-prompt.md` and write your agent's personality:

```markdown
You are a friendly code reviewer. You focus on readability and always
explain your suggestions. You never nitpick formatting.
```

Open `my-agent.agentpkg/soul/identity.json` to set the model:

```json
{
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.3
}
```

### Step 3: Add some memories

Create a file like `my-agent.agentpkg/memories/entries/pref-001.json`:

```json
{
  "id": "pref-001",
  "content": "User prefers TypeScript over JavaScript",
  "type": "preference",
  "importance": 0.9
}
```

### Step 4: Pack it up

```bash
agentpkg pack my-agent.agentpkg
```

This creates `my-agent.agentpkg.zip`, a single portable file you can share, back up, or compile.

### Step 5: Compile to any platform

```bash
# Just Claude Code
agentpkg compile my-agent.agentpkg.zip --target claude-code -o ./output

# Or all platforms at once
agentpkg compile my-agent.agentpkg.zip --target all -o ./output
```

That's it. Your `./output` folder now has the real native files each platform expects.

## Tutorial: Using the Library in Code

If you want to build agents programmatically instead of editing files by hand:

```typescript
import { AgentPackage } from "universal-agent";
import { compile } from "universal-agent/compile";

// Create your agent
const agent = new AgentPackage({
  name: "Research Assistant",
  description: "Helps find and summarize ML papers",
});

// Give it a personality
agent.setSoul(
  "You are an AI research assistant specializing in ML papers. Always cite sources.",
  { model: "claude-sonnet-4-20250514", temperature: 0.3 },
  { rules: ["Always cite sources", "Prefer recent papers"], refusals: [], safetyNotes: [] }
);

// Teach it things
agent.addMemory({ id: "m1", content: "User studies RLHF", type: "preference", importance: 0.9 });

// Give it skills
agent.addSkill({ name: "arxiv-search", description: "Search arxiv for papers", instructions: "# How to search\n..." });

// Give it tools
agent.addTool({ name: "search", description: "Search knowledge base", parameters: { type: "object" } });

// Schedule recurring work
agent.addCron({ name: "daily-digest", schedule: "0 8 * * *", action: "Compile daily paper digest" });

// Connect to services
agent.addIntegration({ name: "slack", type: "mcp", url: "https://slack.mcp.example.com/sse" });

// Add secrets (encrypted when packed)
agent.addSecret({ key: "SLACK_TOKEN", value: "xoxb-...", type: "token", integration: "slack" });

// Add a helper agent
const helper = new AgentPackage({ name: "citation-bot" });
helper.setSoul("Format citations in BibTeX, APA, or MLA.");
agent.addSubagent(helper);

// Pack with encrypted secrets
await agent.pack("research-assistant.agentpkg.zip", "my-passphrase");

// Or compile directly
compile(agent, "claude-code", "./output");
compile(agent, "crewai", "./output");
compile(agent, "copilot", "./output");
```

## Tutorial: Working with Secrets

Secrets (API keys, tokens, passwords) are encrypted with AES-256-GCM before they touch disk. Without the passphrase, the vault is unreadable.

### Packing with secrets

Put your secrets in the `secrets/` folder (one file per secret, filename = key, contents = value), then pack with a passphrase:

```bash
agentpkg pack ./my-agent --passphrase "strong-passphrase-here"
```

### Inspecting without decrypting

You can see which secrets are in a package without the passphrase:

```bash
agentpkg inspect agent.agentpkg.zip
# Shows: 3 secrets (encrypted)
#   SLACK_BOT_TOKEN
#   OPENAI_API_KEY
#   DATABASE_URL
```

### Compiling with secrets

When you compile, pass the passphrase and secrets get injected into the right place for each platform:

```bash
agentpkg compile agent.zip --target claude-code --passphrase "strong-passphrase-here"
```

| Platform | Where secrets end up |
|---|---|
| Claude Code | `.env` file and `.mcp.json` env fields |
| CrewAI | `.env` (environment variables) |
| OpenAI | `.env` and config metadata |
| Others | `.env` file |

### Passphrase tips

agentpkg requires at least 8 characters but will warn you if your passphrase is weak. For real security, use 12+ characters with a mix of letters, numbers, and symbols.

## What's Inside a Package

```
my-agent.agentpkg/
├── manifest.json              # Package metadata
├── soul/
│   ├── system-prompt.md       # The agent's personality
│   ├── identity.json          # Model config (model, temperature, etc.)
│   └── guardrails.json        # Rules and boundaries
├── memories/
│   ├── index.json
│   └── entries/*.json         # Things the agent remembers
├── skills/
│   └── skill-name/
│       ├── skill.json         # Skill metadata
│       ├── SKILL.md           # Skill instructions
│       └── handler.js         # Optional code
├── tools/
│   └── tool-name/
│       └── tool.json          # Tool schema and parameters
├── crons/
│   └── schedules.json         # Scheduled tasks
├── subagents/
│   └── helper.agentpkg/       # Nested agent packages
├── workflows/
│   └── deploy.json            # Multi-step workflows
├── integrations/
│   └── connections.json       # MCP servers, APIs, webhooks
├── knowledge/
│   ├── documents/*.md         # Reference docs
│   └── structured/*.json      # Structured data
├── secrets/
│   └── vault.json             # Encrypted credentials
└── meta/
    └── platform-raw/          # Original platform export (for lossless round trips)
```

## Compile Targets

Each target produces the platform's actual native file structure:

| Target | Flag | What you get |
|---|---|---|
| **Claude Code** | `--target claude-code` | `CLAUDE.md`, `.claude/` with settings, skills, agents, rules, plus `.mcp.json` |
| **Cursor** | `--target cursor` | `.cursor/rules/*.mdc` with proper frontmatter, plus `AGENTS.md` |
| **GitHub Copilot** | `--target copilot` | `.github/copilot-instructions.md`, agents, skills, prompts, plus `AGENTS.md` |
| **Windsurf** | `--target windsurf` | `.windsurf/rules/*.md`, `.windsurfrules`, plus `AGENTS.md` |
| **CrewAI** | `--target crewai` | Full Python project with `pyproject.toml`, `agents.yaml`, `tasks.yaml`, `crew.py`, tools |
| **OpenAI** | `--target openai` | `openai-responses-config.json` (Responses API) and `openai-assistant-config.json` |
| **Microsoft APM** | `--target apm` | `apm.yml`, `.apm/` directory, `AGENTS.md`, `CLAUDE.md` |

## Importing Existing Agents

### From any JSON export

```bash
agentpkg convert export.json --platform relevance-ai -o agent.agentpkg.zip
```

The adapter is fuzzy. It recognizes common key names like `systemPrompt`, `persona`, `soul`, `character`, `memories`, `knowledge_base`, and maps them automatically.

### From OpenClaw

```typescript
import { convertOpenClaw } from "universal-agent/adapters/openclaw";

const pkg = convertOpenClaw("~/.config/openclaw", {
  includeSecrets: true,
  extractSqliteMemories: true,
});

await pkg.pack("my-agent.agentpkg.zip", "migration-passphrase");
```

## Security Auditing

Before installing an agent package you didn't write, scan it:

```bash
agentpkg audit agent.agentpkg.zip
```

The scanner checks for 26 threat patterns:

- **Hidden unicode** (12 patterns): zero width characters, RTL overrides, invisible tag characters
- **Prompt injection** (7 patterns): instruction overrides, jailbreak attempts, encoded payloads
- **Suspicious tools** (7 patterns): credential harvesting, data exfiltration, shell execution

## CLI Commands

```
agentpkg init <name>           Create a new agent package
agentpkg pack <dir>            Bundle into .agentpkg.zip
agentpkg validate <path>       Check package structure is correct
agentpkg inspect <path>        Show what's inside (including secret key names)
agentpkg unpack <zip>          Extract a package
agentpkg convert <json>        Convert a JSON export to agentpkg format
agentpkg audit <path>          Run security scan
agentpkg compile <path>        Compile to platform format
```

### Flags

```
--target <format>         Which platform (claude-code|cursor|copilot|windsurf|crewai|openai|apm|all)
--passphrase <phrase>     Encrypt or decrypt the secrets vault
--include-secrets         Include actual credential values when importing
--platform <name>         Source platform name for the convert command
-o <path>                 Where to write the output
```

## Safety Features

agentpkg includes several protections:

**Secrets are never written in plain text.** They're encrypted with AES-256-GCM and scrypt key derivation before touching disk. The vault stores key names (not values) so you can inspect without decrypting.

**Archives are validated before extraction.** agentpkg reads file headers (magic bytes) to confirm a file is actually a zip or tar archive before extracting. Random or corrupted files are rejected with a clear error.

**Shell commands use safe quoting.** All paths passed to zip/tar/unzip are single-quoted to prevent injection from directory names with spaces or special characters.

**Subagents are checked for integrity.** You can't add two subagents with the same name (which would silently overwrite each other). You also can't create circular references where agent A contains agent B which contains agent A.

**Format versions are checked on load.** If you try to load a package created by a newer version of agentpkg, you'll get a clear error telling you to upgrade instead of silently loading corrupt data.

**Generated code is properly escaped.** Agent names and descriptions with quotes, newlines, colons, or special characters produce valid YAML, Python, and TOML. No more broken output from unusual names.

## Project Structure

```
src/
├── types.ts              285 lines    Type definitions
├── index.ts              943 lines    AgentPackage class, validation, JSON adapter
├── compile.ts            698 lines    7 platform compilers
├── secrets.ts            346 lines    Encrypted vault (AES-256-GCM + scrypt)
├── audit.ts              155 lines    Security scanner
├── deps.ts               192 lines    Dependency resolver
└── adapters/
    └── openclaw.ts       669 lines    OpenClaw filesystem adapter
bin/
└── cli.ts                297 lines    CLI (8 commands)
test/
└── test.js               412 lines    33 tests
```

~4,000 lines of TypeScript. Zero runtime dependencies. 33 tests covering core operations, edge cases, and security validations.

## Contributing

```bash
git clone https://github.com/agrimshar/agentpkg.git
cd agentpkg
npm install
npm test        # 33 tests
npm run build   # TypeScript -> dist/
```

## License

MIT
