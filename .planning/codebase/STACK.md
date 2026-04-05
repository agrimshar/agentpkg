# Technology Stack

**Analysis Date:** 2026-04-05

## Languages

**Primary:**
- TypeScript 5.0.0+ - All source code (`*.ts` files), compiled to ES2022 JavaScript
- JavaScript (compiled from TypeScript) - Runtime execution for CLI and library
- Python - Target compilation output for CrewAI agents (generated, not used in core codebase)

**Secondary:**
- Shell/Bash - System execution via `execSync` from child_process for zip/tar operations
- Markdown - Documentation and content representation for agent souls, skills, knowledge

## Runtime

**Environment:**
- Node.js 18.0.0+ (specified in `engines` field in `package.json`)

**Package Manager:**
- npm (implicit from `package.json` and `npm run` scripts)
- Lockfile: Not detected in repository root (standard `package-lock.json` handling assumed)

## Frameworks

**Core:**
- No external web framework - Pure Node.js standard library (fs, path, crypto, os, child_process)
- Custom AgentPackage class as the primary abstraction (`src/index.ts`)

**Build:**
- TypeScript compiler (tsc) - Compilation target ES2022, CommonJS modules
- Configured via `tsconfig.json` with strict mode enabled

**CLI:**
- Custom CLI implementation (`src/cli.ts`) - Hand-built argument parsing, not a framework like yargs or commander

## Key Dependencies

**Critical:**
- `@types/node` (any version) - Type definitions for Node.js standard library APIs
- `typescript` (^5.0.0) - Language compilation

**Optional/Conditional:**
- `better-sqlite3` - Optional dependency for SQLite memory extraction in OpenClaw adapter (`src/adapters/openclaw.ts`), installed on-demand, not in package.json

**Zero Dependencies:**
- Core library has zero runtime dependencies
- All functionality uses Node.js built-ins: `fs`, `path`, `crypto`, `os`, `child_process`, `execSync`

## Configuration

**Environment:**
- Configuration is file-based: `manifest.json` for agent metadata, integration configs stored in structured JSON
- No `.env` file usage detected in core code
- Secrets are encrypted via AES-256-GCM with scrypt key derivation (in `src/secrets.ts`)

**Build:**
- `tsconfig.json` - ES2022 target, CommonJS modules, strict type checking
- Output directory: `dist/` (not committed)
- Source root: `.` (top-level `*.ts` files) and includes `src/` and `bin/` directories

**Compilation Targets:**
TypeScript compiles to ES2022 with these features:
- Strict null checks enabled
- Force consistent casing in filenames
- Resolution of JSON modules for manifest reading
- Declaration maps for source mapping
- Source maps for debugging

## Exports

**Public API:**
- Main entry: `dist/src/index.js` (types: `dist/src/index.d.ts`)
- Subexports configured via `exports` field in package.json:
  - `.` - Core AgentPackage
  - `./compile` - Multi-platform compiler
  - `./secrets` - Encrypted vault management
  - `./audit` - Security auditing
  - `./deps` - Dependency resolution
  - `./adapters/openclaw` - OpenClaw adapter

**CLI:**
- Binary entry: `dist/bin/cli.js` (installed as `agentpkg` command)

## Platform Requirements

**Development:**
- Node.js 18.0.0 or higher
- TypeScript 5.0.0 or higher
- `zip` or `tar` command-line tools (for packing - fails with informative error if missing)
- Optional: `better-sqlite3` for SQLite memory extraction

**Production:**
- Node.js 18.0.0 or higher
- `zip` or `tar` command-line tools for archiving
- No database required (file-based only)
- No external API clients or SDKs bundled

## Compression & Archiving

**Format Support:**
- Primary: ZIP archives (via system `zip` command)
- Fallback: tar.gz (via system `tar` command)
- Uses `execSync` to shell out to system utilities - pure Node.js approach, no native bindings

**Detection:**
- Attempts `zip` first, falls back to `tar` if unavailable
- Provides clear error message if neither available: "Neither zip nor tar available. Install zip: apt-get install zip"

## Security

**Encryption:**
- Algorithm: AES-256-GCM for secrets vault (`src/secrets.ts`)
- Key derivation: scrypt with N=16384, r=8, p=1
- Salt: 32 bytes random
- IV: 16 bytes random per encryption
- Auth tag: GCM authentication

**Validation:**
- Schema validation for agent packages (`src/index.ts`)
- Manifest structure validation
- Component count consistency checks

---

*Stack analysis: 2026-04-05*
