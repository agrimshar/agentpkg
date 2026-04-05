const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { AgentPackage, convertFromJSON, validate, initScaffold } = require("../dist/src/index");

let passed = 0, failed = 0;

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

test("setSoul stores prompt and config", () => {
  const pkg = new AgentPackage({ name: "test" });
  pkg.setSoul("You are helpful", { model: "claude-sonnet-4-20250514" });
  assert.strictEqual(pkg.systemPrompt, "You are helpful");
  assert.strictEqual(pkg.identityConfig.model, "claude-sonnet-4-20250514");
});

test("addMemory appends correctly", () => {
  const pkg = new AgentPackage({ name: "test" });
  pkg.addMemory({ id: "m1", content: "fact one" });
  pkg.addMemory({ id: "m2", content: "fact two", type: "preference", importance: 0.9 });
  assert.strictEqual(pkg.memories.length, 2);
  assert.strictEqual(pkg.memories[1].type, "preference");
  assert.strictEqual(pkg.memories[1].importance, 0.9);
});

test("addSkill appends with handler code", () => {
  const pkg = new AgentPackage({ name: "test" });
  pkg.addSkill({ name: "search", description: "Search", handlerCode: "function s(){}", triggers: ["find"] });
  assert.strictEqual(pkg.skills.length, 1);
  assert.strictEqual(pkg.skills[0].triggers[0], "find");
});

test("addSubagent accepts AgentPackage instances", () => {
  const parent = new AgentPackage({ name: "parent" });
  const child = new AgentPackage({ name: "child" });
  parent.addSubagent(child);
  assert.strictEqual(parent.subagents.length, 1);
});

test("addSubagent rejects non-AgentPackage", () => {
  const pkg = new AgentPackage({ name: "test" });
  assert.throws(() => pkg.addSubagent({ name: "bad" }), /AgentPackage instance/);
});

test("buildManifest produces correct structure", () => {
  const pkg = new AgentPackage({ name: "test" });
  pkg.setSoul("prompt", { model: "gpt-4" });
  pkg.addMemory({ id: "m1", content: "fact" });
  pkg.addSkill({ name: "s1", description: "skill" });
  pkg.addCron({ name: "c1", schedule: "* * * * *", action: "do stuff" });
  pkg.addIntegration({ name: "slack", type: "mcp", url: "https://slack.mcp.example.com" });
  const m = pkg.buildManifest();
  assert.strictEqual(m.format, "agentpkg");
  assert.strictEqual(m.contents.soul, true);
  assert.strictEqual(m.contents.memories.count, 1);
  assert.strictEqual(m.dependencies.models[0], "gpt-4");
  assert.strictEqual(m.dependencies.mcp_servers[0], "https://slack.mcp.example.com");
});

test("convertFromJSON handles various key formats", () => {
  const raw = {
    agentName: "Test Bot", systemPrompt: "You are helpful", model: "claude-sonnet-4-20250514",
    memories: [{ id: "m1", content: "fact one", type: "fact" }, "plain string memory"],
    skills: [{ name: "search", description: "Find stuff" }],
    tools: [{ name: "calc", description: "Math", parameters: { type: "object" } }],
    crons: [{ name: "daily", schedule: "0 8 * * *", action: "run report" }],
    mcp_servers: ["https://example.com/mcp"],
  };
  const pkg = convertFromJSON(raw, "test-platform");
  assert.strictEqual(pkg.identity.displayName, "Test Bot");
  assert.strictEqual(pkg.systemPrompt, "You are helpful");
  assert.strictEqual(pkg.memories.length, 2);
  assert.strictEqual(pkg.skills.length, 1);
  assert.strictEqual(pkg.tools.length, 1);
  assert.strictEqual(pkg.crons.length, 1);
  assert.strictEqual(pkg.integrations.length, 1);
  assert.strictEqual(pkg.source.platform, "test-platform");
});

test("writeToDir creates correct structure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
  const pkg = new AgentPackage({ name: "test-write" });
  pkg.setSoul("You are a test agent", { model: "test" });
  pkg.addMemory({ id: "m1", content: "memory" });
  pkg.addSkill({ name: "test-skill", description: "test", instructions: "# Test" });
  pkg.addCron({ name: "c1", schedule: "* * * * *", action: "test" });
  const dir = pkg.writeToDir(tmp);
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  assert.ok(fs.existsSync(path.join(dir, "soul", "system-prompt.md")));
  assert.ok(fs.existsSync(path.join(dir, "memories", "entries", "m1.json")));
  assert.ok(fs.existsSync(path.join(dir, "skills", "test-skill", "SKILL.md")));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
  assert.strictEqual(manifest.format, "agentpkg");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("fromDir loads a written package", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
  const original = new AgentPackage({ name: "roundtrip" });
  original.setSoul("Original prompt");
  original.addMemory({ id: "m1", content: "test memory", type: "preference" });
  original.addCron({ name: "c1", schedule: "0 9 * * *", action: "wake up" });
  const dir = original.writeToDir(tmp);
  const loaded = AgentPackage.fromDir(dir);
  assert.strictEqual(loaded.systemPrompt, "Original prompt");
  assert.strictEqual(loaded.memories.length, 1);
  assert.strictEqual(loaded.crons.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("validate catches missing manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
  const result = validate(tmp);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("manifest.json")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("validate passes for valid package", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
  const pkg = new AgentPackage({ name: "valid-test" });
  pkg.setSoul("prompt");
  pkg.addMemory({ id: "m1", content: "test" });
  const dir = pkg.writeToDir(tmp);
  const result = validate(dir);
  assert.strictEqual(result.valid, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("initScaffold creates scaffold", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
  const dir = initScaffold("scaffold-test", tmp);
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  assert.ok(fs.existsSync(path.join(dir, "soul", "system-prompt.md")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

(async () => {
  await testAsync("pack creates zip file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({ name: "pack-test" });
    pkg.setSoul("test prompt");
    const outPath = path.join(tmp, "test.agentpkg.zip");
    const result = await pkg.pack(outPath);
    assert.ok(fs.existsSync(result.path));
    assert.ok(result.size > 0);
    assert.strictEqual(result.checksum.length, 64);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync("fromZip roundtrips correctly", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const original = new AgentPackage({ name: "zip-roundtrip" });
    original.setSoul("Zip test prompt");
    original.addMemory({ id: "m1", content: "zip memory" });
    const outPath = path.join(tmp, "test.agentpkg.zip");
    await original.pack(outPath);
    const loaded = await AgentPackage.fromZip(outPath);
    assert.strictEqual(loaded.systemPrompt, "Zip test prompt");
    assert.strictEqual(loaded.memories.length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync("compile produces all targets with correct structures", async () => {
    const { compileAll } = require("../dist/src/compile");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({ name: "compile-test" });
    pkg.setSoul("test prompt", { model: "gpt-4" }, { rules: ["be nice"], refusals: [], safetyNotes: [] });
    pkg.addSkill({ name: "s1", description: "skill one", instructions: "# S1" });
    pkg.addTool({ name: "t1", description: "tool one", parameters: { type: "object" } });
    pkg.addIntegration({ name: "slack", type: "mcp", url: "https://slack.mcp.example.com/sse" });
    const sub = new AgentPackage({ name: "helper" });
    sub.setSoul("I help.");
    pkg.addSubagent(sub);
    pkg.addWorkflow({ name: "deploy", steps: [{ action: "build" }, { action: "test" }], description: "Deploy flow" });
    const outDir = path.join(tmp, "compiled");
    const results = compileAll(pkg, outDir);
    // All targets should succeed
    for (const [target, result] of Object.entries(results)) {
      assert.ok(!result.error, `${target} failed: ${result.error}`);
      assert.ok(result.dir, `${target} missing dir`);
    }
    // Claude Code: CLAUDE.md + .claude/ + .mcp.json
    assert.ok(fs.existsSync(path.join(outDir, "claude-code", "CLAUDE.md")));
    assert.ok(fs.existsSync(path.join(outDir, "claude-code", ".claude", "settings.json")));
    assert.ok(fs.existsSync(path.join(outDir, "claude-code", ".claude", "skills", "s1", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(outDir, "claude-code", ".claude", "agents", "helper.md")));
    assert.ok(fs.existsSync(path.join(outDir, "claude-code", ".mcp.json")));
    // Cursor: .cursor/rules/*.mdc + AGENTS.md
    assert.ok(fs.existsSync(path.join(outDir, "cursor", ".cursor", "rules", "project.mdc")));
    assert.ok(fs.existsSync(path.join(outDir, "cursor", "AGENTS.md")));
    // Copilot: .github/ tree
    assert.ok(fs.existsSync(path.join(outDir, "copilot", ".github", "copilot-instructions.md")));
    assert.ok(fs.existsSync(path.join(outDir, "copilot", ".github", "agents", "helper.md")));
    assert.ok(fs.existsSync(path.join(outDir, "copilot", ".github", "skills", "s1", "SKILL.md")));
    // Windsurf: .windsurf/rules/*.md
    assert.ok(fs.existsSync(path.join(outDir, "windsurf", ".windsurf", "rules", "project.md")));
    assert.ok(fs.existsSync(path.join(outDir, "windsurf", ".windsurfrules")));
    // CrewAI: full project scaffold
    assert.ok(fs.existsSync(path.join(outDir, "crewai", "src", "compile_test", "config", "agents.yaml")));
    assert.ok(fs.existsSync(path.join(outDir, "crewai", "src", "compile_test", "config", "tasks.yaml")));
    assert.ok(fs.existsSync(path.join(outDir, "crewai", "src", "compile_test", "crew.py")));
    assert.ok(fs.existsSync(path.join(outDir, "crewai", "pyproject.toml")));
    // OpenAI: both Responses and Assistants configs
    assert.ok(fs.existsSync(path.join(outDir, "openai", "openai-responses-config.json")));
    assert.ok(fs.existsSync(path.join(outDir, "openai", "openai-assistant-config.json")));
    // APM: apm.yml + .apm/ + AGENTS.md + CLAUDE.md
    assert.ok(fs.existsSync(path.join(outDir, "apm", "apm.yml")));
    assert.ok(fs.existsSync(path.join(outDir, "apm", ".apm", "agents", "compile-test.agent.md")));
    assert.ok(fs.existsSync(path.join(outDir, "apm", "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(outDir, "apm", "CLAUDE.md")));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync("audit passes on clean package", async () => {
    const { auditDirectory } = require("../dist/src/audit");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({ name: "audit-test" });
    pkg.setSoul("clean prompt");
    const dir = pkg.writeToDir(tmp);
    const result = auditDirectory(dir);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.critical.length, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync("secrets encrypt and decrypt roundtrip", async () => {
    const { encryptSecrets, decryptSecrets } = require("../dist/src/secrets");
    const secrets = [
      { key: "api-key", value: "sk-test-12345", type: "api_key" },
      { key: "bot-token", value: "xoxb-secret-token", type: "token", integration: "slack" },
      { key: "oauth-creds", value: '{"client_id":"abc","client_secret":"xyz"}', type: "oauth_json" },
    ];
    const vault = encryptSecrets(secrets, "test-passphrase-123");
    assert.strictEqual(vault.format, "agentpkg-vault");
    assert.strictEqual(vault.count, 3);
    assert.deepStrictEqual(vault.keys, ["api-key", "bot-token", "oauth-creds"]);
    // Ciphertext should not contain plaintext
    assert.ok(!vault.ciphertext.includes("sk-test-12345"));
    // Decrypt
    const decrypted = decryptSecrets(vault, "test-passphrase-123");
    assert.strictEqual(decrypted.length, 3);
    assert.strictEqual(decrypted[0].value, "sk-test-12345");
    assert.strictEqual(decrypted[1].value, "xoxb-secret-token");
    assert.strictEqual(decrypted[2].integration, undefined); // oauth_json has no integration
  });

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

  await testAsync("pack with secrets creates encrypted vault", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({ name: "secrets-test" });
    pkg.setSoul("test agent");
    pkg.addSecret({ key: "my-api-key", value: "sk-live-abc123", type: "api_key" });
    pkg.addSecret({ key: "db-password", value: "p@ssw0rd!", type: "password", integration: "postgres" });
    const outPath = path.join(tmp, "test.agentpkg.zip");
    const result = await pkg.pack(outPath, "migration-key");
    assert.ok(fs.existsSync(result.path));
    // Unpack and verify vault exists (fall back to tar when unzip absent)
    const { execSync } = require("child_process");
    const unpackDir = path.join(tmp, "unpacked");
    fs.mkdirSync(unpackDir);
    try {
      execSync(`unzip -o "${outPath}" -d "${unpackDir}"`, { stdio: "pipe" });
    } catch {
      execSync(`tar -xf "${outPath}" -C "${unpackDir}"`, { stdio: "pipe" });
    }
    const agentDir = fs.readdirSync(unpackDir).find(f => f.endsWith(".agentpkg"));
    const vaultPath = path.join(unpackDir, agentDir, "secrets", "vault.json");
    assert.ok(fs.existsSync(vaultPath), "vault.json should exist");
    const vault = JSON.parse(fs.readFileSync(vaultPath, "utf-8"));
    assert.strictEqual(vault.format, "agentpkg-vault");
    assert.strictEqual(vault.count, 2);
    assert.deepStrictEqual(vault.keys, ["my-api-key", "db-password"]);
    // Verify we can decrypt
    const { readVault } = require("../dist/src/secrets");
    const decrypted = readVault(vaultPath, "migration-key");
    assert.strictEqual(decrypted[0].value, "sk-live-abc123");
    assert.strictEqual(decrypted[1].value, "p@ssw0rd!");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Regression tests for recent fixes ──

  test("addSubagent rejects name collisions", () => {
    const parent = new AgentPackage({ name: "parent" });
    parent.addSubagent(new AgentPackage({ name: "analyzer" }));
    assert.throws(() => parent.addSubagent(new AgentPackage({ name: "analyzer" })), /collision/i);
  });

  test("addSubagent rejects self-reference", () => {
    const pkg = new AgentPackage({ name: "self" });
    assert.throws(() => pkg.addSubagent(pkg), /circular|itself/i);
  });

  test("addSubagent rejects cycles", () => {
    const a = new AgentPackage({ name: "a" });
    const b = new AgentPackage({ name: "b" });
    a.addSubagent(b);
    assert.throws(() => b.addSubagent(a), /circular/i);
  });

  test("fromDir rejects missing manifest.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    assert.throws(() => AgentPackage.fromDir(tmp), /manifest\.json/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("fromDir rejects wrong format", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({
      format: "not-agentpkg", version: "1.0.0", agent: { name: "x" },
    }));
    assert.throws(() => AgentPackage.fromDir(tmp), /Invalid format/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("fromDir rejects newer major version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({
      format: "agentpkg", version: "99.0.0", agent: { name: "future" },
    }));
    assert.throws(() => AgentPackage.fromDir(tmp), /newer than this agentpkg/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("assessPassphrase flags weak passphrases", () => {
    const { assessPassphrase } = require("../dist/src/secrets");
    assert.ok(assessPassphrase("short") !== null);
    assert.ok(assessPassphrase("aaaaaaaaaaaa") !== null);
    assert.ok(assessPassphrase("lowercaseonly") !== null); // single class
    assert.strictEqual(assessPassphrase("Str0ng!Passphrase"), null);
  });

  await testAsync("CrewAI compiler strips control chars from block scalars", async () => {
    const { compile } = require("../dist/src/compile");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({ name: "ctrl", description: "nulls and bells" });
    // Include NUL (\x00), BEL (\x07), VT (\x0B), DEL (\x7F) — all disallowed in YAML block scalars
    pkg.setSoul("prompt with \x00 null \x07 bell \x0B vt \x7f delete chars");
    const result = compile(pkg, "crewai", tmp);
    assert.ok(!result.error);
    const yamlText = fs.readFileSync(path.join(result.dir, "src", "ctrl", "config", "agents.yaml"), "utf-8");
    assert.ok(!yamlText.includes("\x00"), "NUL should be stripped");
    assert.ok(!yamlText.includes("\x07"), "BEL should be stripped");
    assert.ok(!yamlText.includes("\x7F"), "DEL should be stripped");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync("CrewAI compiler escapes YAML special chars", async () => {
    const { compile } = require("../dist/src/compile");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const pkg = new AgentPackage({
      name: "edge",
      description: 'Has "quotes" and\nnewlines and: colons',
    });
    pkg.setSoul('Backstory with "quotes"\nand newlines');
    pkg.addTool({ name: "calc", description: 'does "math"\nwith newlines', parameters: { type: "object" } });
    const result = compile(pkg, "crewai", tmp);
    assert.ok(!result.error, `crewai failed: ${result.error}`);
    // Validate YAML is parseable
    const yamlPath = path.join(result.dir, "src", "edge", "config", "agents.yaml");
    const yamlText = fs.readFileSync(yamlPath, "utf-8");
    // Basic check: no unescaped raw quotes breaking the quoted scalar
    // The yaml should have the role as a properly escaped double-quoted string
    assert.ok(yamlText.includes('\\"quotes\\"'), "quotes should be escaped");
    assert.ok(!yamlText.includes('role: "Has "quotes"'), "raw quotes should not appear in value");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await testAsync("unzipFile rejects non-archive files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const fake = path.join(tmp, "fake.zip");
    fs.writeFileSync(fake, "not an archive, just plain text");
    try {
      await AgentPackage.fromZip(fake);
      assert.fail("should have rejected non-archive");
    } catch (err) {
      assert.ok(/recognized archive|magic bytes/i.test(err.message), `got: ${err.message}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Security regression tests ──

  test("safeName blocks path traversal in memory IDs", () => {
    const pkg = new AgentPackage({ name: "test" });
    pkg.addMemory({ id: "../../etc/cron.d/evil", content: "payload" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const dir = pkg.writeToDir(tmp);
    // The file should be written inside memories/entries, not escaped to /etc
    const entries = fs.readdirSync(path.join(dir, "memories", "entries"));
    for (const e of entries) {
      assert.ok(!e.includes(".."), `memory file should not contain ..: ${e}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("safeName blocks path traversal in skill names", () => {
    const pkg = new AgentPackage({ name: "test" });
    pkg.addSkill({ name: "../../../tmp/pwned", description: "evil" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    const dir = pkg.writeToDir(tmp);
    // Should be contained inside skills/
    const skillDirs = fs.readdirSync(path.join(dir, "skills")).filter(f => f !== "index.json");
    for (const d of skillDirs) {
      assert.ok(!d.includes(".."), `skill dir should not contain ..: ${d}`);
    }
    // And /tmp/pwned should NOT exist
    assert.ok(!fs.existsSync("/tmp/pwned"), "path traversal should not create /tmp/pwned");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("envQuote prevents .env injection via newlines in secret values", () => {
    const { encryptSecrets, decryptSecrets, injectSecrets } = require("../dist/src/secrets");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpkg-ts-"));
    // A malicious secret value with embedded newlines trying to inject EVIL_VAR
    const secrets = [
      { key: "normal-key", value: 'real-value\nEVIL_VAR=malicious', type: "api_key" },
      { key: "has-quotes", value: 'value with "quotes" inside', type: "token" },
    ];
    injectSecrets(secrets, "cursor", tmp); // cursor uses generic .env injection
    const envContent = fs.readFileSync(path.join(tmp, ".env"), "utf-8");
    // The EVIL_VAR should NOT appear as its own line/variable
    const lines = envContent.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    const keys = lines.map(l => l.split("=")[0]);
    assert.ok(!keys.includes("EVIL_VAR"), `newline injection should be blocked, got: ${envContent}`);
    // Values should be double-quoted
    assert.ok(envContent.includes('NORMAL_KEY="'), "values should be double-quoted");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
