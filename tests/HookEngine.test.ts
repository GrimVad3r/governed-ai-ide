// ============================================================
// tests/HookEngine.test.ts — Full Integration Test Suite
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HookEngine } from "../src/hooks/HookEngine";
import { HookEngineConfig } from "../src/hooks/types";
import { ContentHasher } from "../src/hooks/ContentHasher";
import { CommandClassifier } from "../src/hooks/CommandClassifier";

// ── Test Fixtures ────────────────────────────────────────────

const SAMPLE_INTENTS_YAML = `
active_intents:
  - id: INT-001
    name: JWT Authentication Migration
    status: PENDING
    owned_scope:
      - src/auth/**
      - src/middleware/jwt.ts
    constraints:
      - Must not use external auth providers
    acceptance_criteria:
      - Unit tests in tests/auth/ pass
    related_requirements:
      - REQ-042
  - id: INT-002
    name: Weather API
    status: COMPLETE
    owned_scope:
      - src/weather/**
    constraints: []
    acceptance_criteria: []
`.trim();

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "governed-ai-test-"));
  const orchestrationDir = path.join(dir, ".orchestration");
  fs.mkdirSync(orchestrationDir, { recursive: true });
  fs.writeFileSync(
    path.join(orchestrationDir, "active_intents.yaml"),
    SAMPLE_INTENTS_YAML
  );
  fs.writeFileSync(
    path.join(orchestrationDir, ".intentignore"),
    ".orchestration/**\nnode_modules/**\n*.lock\n"
  );
  fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  return dir;
}

function makeConfig(workspaceRoot: string): HookEngineConfig {
  return {
    orchestrationDir: path.join(workspaceRoot, ".orchestration"),
    workspaceRoot,
    agentLabel: "Builder",
    modelIdentifier: "claude-sonnet-4-6",
    enableHITL: false,  // Off for deterministic tests
    enableScopeEnforcement: true,
    enableConcurrencyGuard: true,
    enableTracing: true,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("ContentHasher", () => {
  it("produces consistent hashes", () => {
    const h1 = ContentHasher.hash("hello world");
    const h2 = ContentHasher.hash("hello world");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:/);
  });

  it("produces different hashes for different content", () => {
    expect(ContentHasher.hash("foo")).not.toBe(ContentHasher.hash("bar"));
  });

  it("detects changed line ranges", () => {
    const old = "line1\nline2\nline3\nline4\nline5";
    const newC = "line1\nLINE2_CHANGED\nline3\nLINE4_CHANGED\nline5";
    const ranges = ContentHasher.diffLineRanges(old, newC);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0].content_hash).toMatch(/^sha256:/);
  });
});

describe("CommandClassifier", () => {
  it("classifies read_file as SAFE", () => {
    expect(CommandClassifier.classify("read_file", {})).toBe("SAFE");
  });

  it("classifies write_to_file as DESTRUCTIVE", () => {
    expect(CommandClassifier.classify("write_to_file", {})).toBe("DESTRUCTIVE");
  });

  it("classifies execute_command with rm -rf as ELEVATED", () => {
    expect(
      CommandClassifier.classify("execute_command", { command: "rm -rf /tmp/test" })
    ).toBe("ELEVATED");
  });

  it("classifies select_active_intent as SAFE", () => {
    expect(CommandClassifier.classify("select_active_intent", {})).toBe("SAFE");
  });

  it("extracts file path from parameters", () => {
    expect(
      CommandClassifier.extractTargetPath("write_to_file", { path: "src/auth/jwt.ts" })
    ).toBe("src/auth/jwt.ts");
  });
});

describe("HookEngine — Intent Gating", () => {
  let workspaceRoot: string;
  let engine: HookEngine;

  beforeEach(() => {
    HookEngine.reset();
    workspaceRoot = createTempWorkspace();
    engine = HookEngine.getInstance(makeConfig(workspaceRoot), async () => true);
  });

  afterEach(() => {
    HookEngine.reset();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("blocks write_to_file when no intent is declared", async () => {
    const session = engine.createSession("Builder");
    const result = await engine.preProcess({
      toolName: "write_to_file",
      parameters: { path: "src/auth/jwt.ts", content: "// code" },
      sessionId: session.sessionId,
    });
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe("NO_ACTIVE_INTENT");
    expect(result.error?.recoveryHint).toContain("select_active_intent");
  });

  it("allows select_active_intent without a prior intent", async () => {
    const session = engine.createSession();
    const result = await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-001" },
      sessionId: session.sessionId,
    });
    expect(result.allowed).toBe(true);
    expect(result.injectedContext).toContain("<id>INT-001</id>");
    expect(result.injectedContext).toContain("owned_scope");
  });

  it("rejects invalid intent ID", async () => {
    const session = engine.createSession();
    const result = await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-999" },
      sessionId: session.sessionId,
    });
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe("INVALID_INTENT_ID");
  });

  it("rejects COMPLETE intent", async () => {
    const session = engine.createSession();
    const result = await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-002" },  // status: COMPLETE
      sessionId: session.sessionId,
    });
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe("INVALID_INTENT_ID");
  });

  it("allows write after intent is selected", async () => {
    const session = engine.createSession();

    // Step 1: select intent
    await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-001" },
      sessionId: session.sessionId,
    });

    // Step 2: write within scope
    const filePath = path.join(workspaceRoot, "src", "auth", "jwt.ts");
    fs.writeFileSync(filePath, "// initial content");

    const result = await engine.preProcess({
      toolName: "write_to_file",
      parameters: { path: filePath, content: "// new content" },
      sessionId: session.sessionId,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("HookEngine — Scope Enforcement", () => {
  let workspaceRoot: string;
  let engine: HookEngine;

  beforeEach(() => {
    HookEngine.reset();
    workspaceRoot = createTempWorkspace();
    engine = HookEngine.getInstance(makeConfig(workspaceRoot), async () => true);
  });

  afterEach(() => {
    HookEngine.reset();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("blocks write to file outside intent scope", async () => {
    const session = engine.createSession();

    await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-001" },
      sessionId: session.sessionId,
    });

    // INT-001 only owns src/auth/** and src/middleware/jwt.ts
    const outOfScope = path.join(workspaceRoot, "src", "weather", "api.ts");

    const result = await engine.preProcess({
      toolName: "write_to_file",
      parameters: { path: outOfScope, content: "// code" },
      sessionId: session.sessionId,
    });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe("SCOPE_VIOLATION");
    expect(result.error?.recoveryHint).toContain("expand_intent_scope");
  });

  it("blocks writes to .intentignore'd paths", async () => {
    const session = engine.createSession();
    await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-001" },
      sessionId: session.sessionId,
    });

    const ignoredPath = path.join(workspaceRoot, "node_modules", "lodash", "index.js");

    const result = await engine.preProcess({
      toolName: "write_to_file",
      parameters: { path: ignoredPath, content: "// code" },
      sessionId: session.sessionId,
    });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe("INTENTIGNORE_MATCH");
  });
});

describe("HookEngine — Concurrency Guard", () => {
  let workspaceRoot: string;
  let engine: HookEngine;

  beforeEach(() => {
    HookEngine.reset();
    workspaceRoot = createTempWorkspace();
    engine = HookEngine.getInstance(makeConfig(workspaceRoot), async () => true);
  });

  afterEach(() => {
    HookEngine.reset();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("detects stale file and blocks write", async () => {
    const session = engine.createSession();

    // Select intent
    await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-001" },
      sessionId: session.sessionId,
    });

    const filePath = path.join(workspaceRoot, "src", "auth", "jwt.ts");
    fs.writeFileSync(filePath, "// version 1");

    // Agent reads file — snapshot taken
    await engine.preProcess({
      toolName: "read_file",
      parameters: { path: filePath },
      sessionId: session.sessionId,
    });
    // Simulate post-hook snapshot
    await engine.postProcess({
      toolName: "read_file",
      parameters: { path: filePath },
      result: null,
      sessionId: session.sessionId,
    });

    // Another agent modifies the file (simulate parallel edit)
    fs.writeFileSync(filePath, "// version 2 — modified by Agent B");

    // Agent A tries to write — should detect stale
    const result = await engine.preProcess({
      toolName: "write_to_file",
      parameters: { path: filePath, content: "// agent A version" },
      sessionId: session.sessionId,
    });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe("STALE_FILE");
    expect(result.error?.recoveryHint).toContain("read_file");
  });
});

describe("HookEngine — Trace Logging", () => {
  let workspaceRoot: string;
  let engine: HookEngine;

  beforeEach(() => {
    HookEngine.reset();
    workspaceRoot = createTempWorkspace();
    engine = HookEngine.getInstance(makeConfig(workspaceRoot), async () => true);
  });

  afterEach(() => {
    HookEngine.reset();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("writes trace entry after file write", async () => {
    const session = engine.createSession();

    // Select intent
    await engine.preProcess({
      toolName: "select_active_intent",
      parameters: { intent_id: "INT-001" },
      sessionId: session.sessionId,
    });

    // Simulate file write
    const filePath = path.join(workspaceRoot, "src", "auth", "jwt.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const newContent = "export function generateToken() { return 'jwt'; }";
    fs.writeFileSync(filePath, newContent);

    await engine.postProcess({
      toolName: "write_to_file",
      parameters: { path: filePath, content: newContent },
      result: null,
      sessionId: session.sessionId,
      mutationClass: "AST_REFACTOR",
    });

    const tracePath = path.join(workspaceRoot, ".orchestration", "agent_trace.jsonl");
    expect(fs.existsSync(tracePath)).toBe(true);

    const entries = fs
      .readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    expect(entries.length).toBe(1);
    expect(entries[0].intent_id).toBe("INT-001");
    expect(entries[0].files[0].mutation_class).toBe("AST_REFACTOR");
    expect(entries[0].files[0].conversations[0].ranges[0].content_hash).toMatch(/^sha256:/);
  });
});