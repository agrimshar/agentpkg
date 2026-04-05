# Coding Conventions

**Analysis Date:** 2026-04-05

## Naming Patterns

**Files:**
- TypeScript source files are `camelCase.ts` (e.g., `index.ts`, `compile.ts`, `audit.ts`)
- Test file is `test.js` at root level (not co-located)
- Config files are named with `dotfiles` and lowercase with hyphens where needed (`tsconfig.json`, `package.json`)

**Functions:**
- Utility functions: `camelCase` (e.g., `slugify()`, `writeJson()`, `sha256File()`)
- Helper functions inside modules: short lowercase names prefixed with underscore if private (e.g., `_handlerCode`)
- Exported functions: `camelCase` (e.g., `encryptSecrets()`, `decryptSecrets()`, `auditDirectory()`)
- Async functions: same naming convention, called with `await` at callsite

**Variables:**
- Local variables and constants: `camelCase` (e.g., `relPath`, `plaintext`, `authTag`)
- Private fields in classes: prefixed with underscore then `camelCase` (e.g., `_handlerCode`)
- Object properties matching JSON/manifest format: `snake_case` when stored to disk (e.g., `display_name`, `created_at`, `exported_at` in manifest output), but `camelCase` in TypeScript code (e.g., `displayName`, `createdAt`)
- Constants for configuration: `UPPER_SNAKE_CASE` (e.g., `SCRYPT_COST`, `KEY_LENGTH`, `LOCKFILE_NAME`)

**Types:**
- Interfaces: `PascalCase` (e.g., `AgentIdentity`, `AgentPackage`, `ValidationResult`, `EncryptedVault`)
- Type aliases: `PascalCase` (e.g., `CompileTarget`, `AuditSeverity`, `DepType`)
- Literal union types with lowercase strings (e.g., `"fact" | "preference" | "episodic"` for Memory type)

## Code Style

**Formatting:**
- TypeScript compiler configured with `strict: true`, `esModuleInterop: true`
- Target: ES2022
- Module system: CommonJS (`"module": "commonjs"`)
- No external formatter configured (Prettier or ESLint not in devDeps)
- Indentation: 2 spaces (evident from JSON output formatting)

**Linting:**
- No ESLint configuration found
- No Prettier configuration found
- Relies on TypeScript `strict` mode for type safety

**Code Structure:**
- Visual section separators using Unicode box-drawing characters:
  ```typescript
  // ─────────────────────────────────────────────
  // Section Name
  // ─────────────────────────────────────────────
  ```
- Sections logically group related functionality (e.g., "Soul", "Memories", "Skills" in AgentPackage class)

## Import Organization

**Order:**
1. Node built-in modules with `import * as` (e.g., `import * as fs from "fs"`)
2. Custom imports from local files (e.g., `import { AgentPackage, slugify } from "./index"`)
3. Type imports from `./types` using `type` keyword (e.g., `import type { Memory, Skill } from "./types"`)

**Pattern:**
```typescript
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { AgentPackage, slugify } from "./index";
import type { Secret, EncryptedVault } from "./types";
```

**Path Aliases:**
- None detected; relative imports only (e.g., `../src/index`)

## Error Handling

**Patterns:**
- Direct throws using `throw new Error("message")` with descriptive text
- Try-catch blocks for external operations (file I/O, shell execution):
  ```typescript
  try {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { stdio: "pipe" });
    } catch {
      throw new Error("Neither unzip nor tar available.");
    }
  }
  ```
- Silent catches with empty comments for non-critical operations:
  ```typescript
  try {
    // parse JSON or read file
  } catch { /* skip */ }
  ```
- Validation-first approach: check parameters and throw early (e.g., in `encryptSecrets()`, passphrase length validated before processing)

## Logging

**Framework:** `console.log()` and color-coded output via ANSI escape codes in CLI

**Patterns:**
- CLI colors defined as constants in color palette object `c` (e.g., `c.green`, `c.red`, `c.yellow`)
- Helper functions for consistent logging: `success()`, `error()`, `warn()`, `info()`, `heading()` in `cli.ts`
- Example:
  ```typescript
  const success = (msg: string) => log(`${c.green}✓${c.reset} ${msg}`);
  const error = (msg: string) => log(`${c.red}✗${c.reset} ${msg}`);
  ```
- No structured logging framework (pino, winston, etc.)

## Comments

**When to Comment:**
- File headers with /** block comments explaining module purpose and usage (e.g., `secrets.ts`, `compile.ts`)
- Section headers using visual separators (dashes and newlines)
- Inline /** comments for JSDoc on exports and public APIs
- Post-decision comments in complex logic (e.g., pattern definitions with severity levels)

**JSDoc/TSDoc:**
- Used for public interfaces and exported functions
- Format: `/** description text */` on single line or multi-line before declaration
- Example from `types.ts`:
  ```typescript
  export interface Secret {
    /** Unique key, e.g. "telegram-bot-token", "openai-api-key" */
    key: string;
    /** The actual secret value (plaintext in memory, encrypted on disk) */
    value: string;
  }
  ```

## Function Design

**Size:** 
- Most utility functions are 5-20 lines
- Complex operations broken into named helper functions (e.g., `importantMemories()`, `buildMemoryBlock()`)
- No strict line limits observed; driven by readability

**Parameters:** 
- Options objects used for functions with multiple optional parameters:
  ```typescript
  addMemory(opts: {
    id: string;
    content: string;
    type?: string;
    metadata?: Record<string, unknown>;
    importance?: number;
    source?: string;
  }): this
  ```
- Single required params passed directly
- Defaults applied with nullish coalescing: `opts.type ?? "fact"`

**Return Values:**
- Methods return `this` for chaining (builder pattern):
  ```typescript
  setSoul(...): this { ... return this; }
  addMemory(...): this { ... return this; }
  ```
- Utility functions return specific types (`string`, `void`, `Buffer`, `Record<string, unknown>`)
- Constructor methods can be static (e.g., `AgentPackage.fromDir()`, `AgentPackage.fromZip()`)

## Module Design

**Exports:**
- Barrel exports in `index.ts`: `export * from "./types"`
- Named exports for classes: `export class AgentPackage { ... }`
- Named exports for functions: `export function slugify(...)`
- Named exports in package.json "exports" field define public submodule access:
  ```json
  "exports": {
    ".": { "types": "./dist/src/index.d.ts", "default": "./dist/src/index.js" },
    "./compile": { "types": "./dist/src/compile.d.ts", "default": "./dist/src/compile.js" }
  }
  ```

**Barrel Files:**
- `index.ts` re-exports all types from `./types` using `export * from "./types"`
- Used to provide single entry point for consumers
- Specific submodule exports in package.json for tree-shaking support

---

*Convention analysis: 2026-04-05*
