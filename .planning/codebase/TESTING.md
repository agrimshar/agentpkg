# Testing Patterns

**Analysis Date:** 2026-04-05

## Test Framework

**Runner:**
- Node.js built-in `assert` module
- No external test framework (Jest, Vitest, Mocha not used)
- Config: None (uses Node.js defaults)

**Assertion Library:**
- Node.js `assert` standard library
- Methods used: `assert.strictEqual()`, `assert.ok()`, `assert.throws()`, `assert.fail()`, `assert.deepStrictEqual()`

**Run Commands:**
```bash
npm test              # Builds TypeScript, then runs node test/test.js
npm run build         # Compiles TypeScript to dist/
```

## Test File Organization

**Location:**
- Single test file at repository root: `test.js` (not co-located with source)
- Tests import compiled output from `../dist/src/` rather than TypeScript sources

**Naming:**
- Test file: `test.js`
- No `.test.ts` or `.spec.ts` files found
- Test descriptions use clear English phrases (e.g., "AgentPackage constructor sets identity")

**Structure:**
```
agentpkg/
├── test.js                 # All tests in single file
├── src/                    # TypeScript source (if existed)
└── dist/                   # Compiled JavaScript (consumed by tests)
```

## Test Structure

**Suite Organization:**
```typescript
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log("\nagentpkg (TypeScript) test suite\n");

test("AgentPackage constructor sets identity", () => {
  const pkg = new AgentPackage({ name: "Test Agent", description: "A test", author: "tester" });
  assert.strictEqual(pkg.identity.name, "test-agent");
  assert.strictEqual(pkg.identity.displayName, "Test Agent");
});
```

**Patterns:**
- Simple test runner with manual try-catch
- Manual pass/fail counter tracked with `passed` and `failed` variables
- Synchronous tests use `test()`, async tests use `testAsync()`
- Output format: checkmark (✓) for pass, cross (✗) for fail with error message
- Test execution: synchronous tests run immediately, async tests batched in IIFE with `(async () => { ... })()`
- Final summary printed after all tests complete

## Mocking

**Framework:** 
- Manual mocking via `require()` of compiled modules
- No mock library (Sinon, Jest mock, etc.)

**Patterns:**
```javascript
const { AgentPackage, convertFromJSON, validate, initScaffold } = require("../dist/src/index");
const { auditDirectory } = require("../dist/src/audit");
const { compileAll } = require("../dist/src/compile");
const { encryptSecrets, decryptSecrets } = require("../dist/src/secrets");
```

**What to Mock:**
- External modules not mocked; integration tests preferred
- File system operations: tests use real `fs` with `fs.mkdtempSync()` to create temp directories
- Shell commands: real `execSync()` called for zip/tar operations (no mocking)

**What NOT to Mock:**
- Core functionality (AgentPackage class methods)
- File I/O (tests work with actual filesystem)
- Child process execution (shell commands run for real)
- Type validation and assertions (tested directly)

## Fixtures and Factories

**Test Data:**
```javascript
const pkg = new AgentPackage({ name: "test" });
pkg.setSoul("You are helpful", { model: "claude-sonnet-4-20250514" });
pkg.addMemory({ id: "m1", content: "fact one" });
pkg.addMemory({ id: "m2", content: "fact two", type: "preference", importance: 0.9 });

// Or from JSON:
const raw = {
  agentName: "Test Bot", 
  systemPrompt: "You are helpful", 
  model: "claude-sonnet-4-20250514",
  memories: [{ id: "m1", content: "fact one", type: "fact" }, "plain string memory"],
  skills: [{ name: "search", description: "Find stuff" }],
};
const pkg = convertFromJSON(raw, "test-platform");
```

**Location:**
- Inline in test functions using builder pattern (no separate fixture files)
- Temporary directories created per test with `fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"))`
- Cleanup done with `fs.rmSync(tmp, { recursive: true, force: true })` in finally block

## Coverage

**Requirements:** 
- No coverage requirements enforced
- No coverage tool configured (Istanbul, nyc, c8 not in devDeps)
- Tests are integration-style, covering happy paths and error cases

**View Coverage:**
- No command available
- No coverage reports generated

## Test Types

**Unit Tests:**
- Constructor and property initialization (e.g., "AgentPackage constructor sets identity")
- Builder method chaining (e.g., "setSoul stores prompt and config")
- Array mutations (e.g., "addMemory appends correctly")
- Type validation (e.g., "addSubagent rejects non-AgentPackage")
- Scope: Individual class methods and functions in isolation

**Integration Tests:**
- Package serialization/deserialization (e.g., "writeToDir creates correct structure", "fromDir loads a written package")
- Format conversions (e.g., "convertFromJSON handles various key formats")
- Validation pipeline (e.g., "validate catches missing manifest", "validate passes for valid package")
- File operations roundtrips (e.g., "pack creates zip file", "fromZip roundtrips correctly")
- Compilation to multiple targets (e.g., "compile produces all targets with correct structures")
- Scope: Full workflows involving multiple components

**E2E Tests:**
- Not separate category; integration tests serve this role
- Examples: compile test verifies all 8 platform outputs exist with correct file structures
- Audit test verifies detection of security issues in complete packages

## Common Patterns

**Async Testing:**
```javascript
(async () => {
  await testAsync("pack creates zip file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({ name: "pack-test" });
    pkg.setSoul("test prompt");
    const outPath = path.join(tmp, "test.agentpkg.zip");
    const result = await pkg.pack(outPath);
    assert.ok(fs.existsSync(result.path));
    assert.ok(result.size > 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ... more async tests ...
})();
```

**Error Testing:**
```javascript
test("addSubagent rejects non-AgentPackage", () => {
  const pkg = new AgentPackage({ name: "test" });
  assert.throws(() => pkg.addSubagent({ name: "bad" }), /AgentPackage instance/);
});

// Also used for crypto validation:
await testAsync("secrets wrong passphrase throws", async () => {
  const { encryptSecrets, decryptSecrets } = require("../dist/src/secrets");
  const vault = encryptSecrets([{ key: "k", value: "v", type: "api_key" }], "correct-pass");
  try {
    decryptSecrets(vault, "wrong-pass");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err.message.includes("wrong passphrase"));
  }
});
```

**Existential Assertions:**
```javascript
// Verify generated file structure:
assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
assert.ok(fs.existsSync(path.join(dir, "soul", "system-prompt.md")));
assert.ok(fs.existsSync(path.join(dir, "skills", "test-skill", "SKILL.md")));

// Verify properties:
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
assert.strictEqual(manifest.format, "agentpkg");
```

---

*Testing analysis: 2026-04-05*
