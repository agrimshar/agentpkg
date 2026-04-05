import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { DepSpec, DepType, LockfileData, ResolvedDep } from "./types";

export const LOCKFILE_NAME = "agentpkg.lock.json";

// ─────────────────────────────────────────────
// Parse dependency strings
// ─────────────────────────────────────────────

export function parseDep(depString: string): DepSpec {
  const match = depString.match(/^(git|npm|local|url):(.+)$/);
  if (!match) {
    if (depString.includes("/") && !depString.startsWith(".")) {
      return { type: "git", source: depString, ref: "main", raw: depString };
    }
    return { type: "npm", source: depString, version: "latest", raw: depString };
  }

  const [, type, rest] = match;
  const spec: DepSpec = { type: type as DepType, raw: depString, source: "" };

  switch (type) {
    case "git": {
      const [source, ref] = rest.split("#");
      spec.source = source;
      spec.ref = ref ?? "main";
      break;
    }
    case "npm": {
      const [source, version] = rest.split("@");
      spec.source = source;
      spec.version = version ?? "latest";
      break;
    }
    case "local":
    case "url":
      spec.source = rest;
      break;
  }

  return spec;
}

// ─────────────────────────────────────────────
// Lockfile
// ─────────────────────────────────────────────

export class Lockfile {
  private filePath: string;
  data: LockfileData;

  constructor(filePath: string = LOCKFILE_NAME) {
    this.filePath = filePath;
    this.data = { version: 1, resolved: {}, dependency_tree: {} };
  }

  load(): this {
    if (fs.existsSync(this.filePath)) {
      this.data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    }
    return this;
  }

  save(): this {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    return this;
  }

  lock(key: string, info: ResolvedDep): this {
    this.data.resolved[key] = { ...info, resolved_at: new Date().toISOString() };
    return this;
  }

  isLocked(key: string): boolean {
    return key in this.data.resolved;
  }

  getResolved(key: string): ResolvedDep | null {
    return this.data.resolved[key] ?? null;
  }

  setTree(key: string, deps: string[]): this {
    this.data.dependency_tree[key] = deps;
    return this;
  }
}

// ─────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────

interface ResolveEntry {
  key: string;
  spec: DepSpec;
  [k: string]: unknown;
}

export class DependencyResolver {
  private lockfile: Lockfile;
  private resolved: Map<string, ResolvedDep> = new Map();
  resolveOrder: ResolveEntry[] = [];

  constructor(lockfile?: Lockfile) {
    this.lockfile = lockfile ?? new Lockfile();
  }

  async resolve(deps: (string | DepSpec)[], depth: number = 0): Promise<ResolveEntry[]> {
    if (depth > 20) throw new Error("Dependency depth exceeded 20 — circular dependency?");

    for (const dep of deps) {
      const spec = typeof dep === "string" ? parseDep(dep) : dep;
      const key = `${spec.type}:${spec.source}`;

      if (this.resolved.has(key)) continue;

      if (this.lockfile.isLocked(key)) {
        const locked = this.lockfile.getResolved(key)!;
        this.resolved.set(key, locked);
        this.resolveOrder.push({ key, spec, ...locked });
        const transitive = this.lockfile.data.dependency_tree[key] ?? [];
        if (transitive.length) await this.resolve(transitive, depth + 1);
        continue;
      }

      const resolved = this.resolveSpec(spec);
      this.resolved.set(key, resolved);
      this.resolveOrder.push({ key, spec, ...resolved });
      this.lockfile.lock(key, resolved);

      if (resolved.dependencies.length) {
        this.lockfile.setTree(key, resolved.dependencies);
        await this.resolve(resolved.dependencies, depth + 1);
      }
    }

    return this.resolveOrder;
  }

  private resolveSpec(spec: DepSpec): ResolvedDep {
    switch (spec.type) {
      case "local": return this.resolveLocal(spec);
      case "git": return { type: "git", source: spec.source, ref: spec.ref, resolved_ref: spec.ref,
        resolved_at: "", checksum: null, dependencies: [],
        _note: "Git resolution requires network. Run agentpkg install to fetch." };
      case "npm": return { type: "npm", source: spec.source, version: spec.version, resolved_version: spec.version,
        resolved_at: "", checksum: null, dependencies: [],
        _note: "npm resolution requires network. Run agentpkg install to fetch." };
      case "url": return { type: "url", source: spec.source,
        resolved_at: "", checksum: null, dependencies: [],
        _note: "URL resolution requires network. Run agentpkg install to fetch." };
      default: throw new Error(`Unknown dependency type: ${spec.type}`);
    }
  }

  private resolveLocal(spec: DepSpec): ResolvedDep {
    const resolved = path.resolve(spec.source);
    if (!fs.existsSync(resolved)) throw new Error(`Local dependency not found: ${spec.source}`);

    let dependencies: string[] = [];
    const manifestPath = path.join(resolved, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      dependencies = manifest.dependencies?.packages ?? [];
    }

    return {
      type: "local", source: spec.source, resolved_path: resolved,
      resolved_at: "", checksum: this.checksumDir(resolved), dependencies,
    };
  }

  private checksumDir(dirPath: string): string {
    const hash = crypto.createHash("sha256");
    for (const file of this.walkDir(dirPath).sort()) {
      hash.update(file);
      hash.update(fs.readFileSync(file));
    }
    return hash.digest("hex");
  }

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...this.walkDir(full));
      else results.push(full);
    }
    return results;
  }
}
