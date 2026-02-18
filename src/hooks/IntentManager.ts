// ============================================================
// IntentManager.ts — CRUD for active_intents.yaml
// ============================================================
// Purpose: Single source of truth for loading, querying, and
// updating the intent specification file. Treats the codebase
// as a collection of formalized intents, not just text files.

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { minimatch } from "minimatch";
import {
  ActiveIntent,
  ActiveIntentsFile,
  IntentStatus,
  HookEngineConfig,
} from "./types";

export class IntentManager {
  private readonly intentsPath: string;
  private readonly intentMapPath: string;
  private config: HookEngineConfig;

  constructor(config: HookEngineConfig) {
    this.config = config;
    this.intentsPath = path.join(
      config.orchestrationDir,
      "active_intents.yaml"
    );
    this.intentMapPath = path.join(config.orchestrationDir, "intent_map.md");
  }

  // ── Read ──────────────────────────────────────────────────

  /** Load and parse the full intents file */
  loadAll(): ActiveIntentsFile {
    if (!fs.existsSync(this.intentsPath)) {
      return { active_intents: [] };
    }
    const raw = fs.readFileSync(this.intentsPath, "utf8");
    const parsed = yaml.load(raw) as ActiveIntentsFile;
    return parsed ?? { active_intents: [] };
  }

  /** Get a specific intent by ID */
  getById(intentId: string): ActiveIntent | null {
    const { active_intents } = this.loadAll();
    return active_intents.find((i) => i.id === intentId) ?? null;
  }

  /** Get all intents with a given status */
  getByStatus(status: IntentStatus): ActiveIntent[] {
    const { active_intents } = this.loadAll();
    return active_intents.filter((i) => i.status === status);
  }

  /** Validate that an intent ID exists and is actionable */
  isValidIntent(intentId: string): boolean {
    const intent = this.getById(intentId);
    if (!intent) return false;
    return intent.status !== "COMPLETE" && intent.status !== "ABANDONED";
  }

  // ── Scope Enforcement ────────────────────────────────────

  /**
   * Check if a file path is within the owned_scope of an intent.
   * owned_scope entries are glob patterns relative to workspace root.
   */
  isFileInScope(intentId: string, filePath: string): boolean {
    const intent = this.getById(intentId);
    if (!intent) return false;

    // Normalize path relative to workspace root
    const relPath = path.isAbsolute(filePath)
      ? path.relative(this.config.workspaceRoot, filePath)
      : filePath;

    return intent.owned_scope.some((pattern) =>
      minimatch(relPath, pattern, { matchBase: true, dot: true })
    );
  }

  // ── Write ─────────────────────────────────────────────────

  /** Persist the full intents object back to YAML */
  private save(data: ActiveIntentsFile): void {
    const yamlStr = yaml.dump(data, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
    });
    fs.mkdirSync(path.dirname(this.intentsPath), { recursive: true });
    fs.writeFileSync(this.intentsPath, yamlStr, "utf8");
  }

  /** Update a single field on an existing intent */
  updateIntent(intentId: string, updates: Partial<ActiveIntent>): boolean {
    const data = this.loadAll();
    const idx = data.active_intents.findIndex((i) => i.id === intentId);
    if (idx === -1) return false;

    data.active_intents[idx] = {
      ...data.active_intents[idx],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    this.save(data);
    return true;
  }

  /** Mark an intent as IN_PROGRESS when an agent selects it */
  markInProgress(intentId: string): boolean {
    return this.updateIntent(intentId, { status: "IN_PROGRESS" });
  }

  /** Mark an intent as COMPLETE */
  markComplete(intentId: string): boolean {
    return this.updateIntent(intentId, { status: "COMPLETE" });
  }

  /** Add a new intent programmatically */
  addIntent(intent: ActiveIntent): void {
    const data = this.loadAll();
    const exists = data.active_intents.some((i) => i.id === intent.id);
    if (exists) throw new Error(`Intent ${intent.id} already exists`);
    data.active_intents.push({
      ...intent,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.save(data);
  }

  // ── Context Building ─────────────────────────────────────

  /**
   * Build the XML context block injected into the LLM prompt.
   * This is the core of the "Reasoning Intercept" — it gives the
   * agent deep, structured knowledge before it writes a single line.
   */
  buildContextBlock(intentId: string): string {
    const intent = this.getById(intentId);
    if (!intent) {
      return `<intent_context>\n  <error>Intent ${intentId} not found</error>\n</intent_context>`;
    }

    const constraintLines = intent.constraints
      .map((c) => `    <constraint>${c}</constraint>`)
      .join("\n");

    const scopeLines = intent.owned_scope
      .map((s) => `    <glob>${s}</glob>`)
      .join("\n");

    const criteriaLines = intent.acceptance_criteria
      .map((ac) => `    <criterion>${ac}</criterion>`)
      .join("\n");

    const relatedLines = (intent.related_requirements ?? [])
      .map((r) => `    <requirement>${r}</requirement>`)
      .join("\n");

    return `<intent_context>
  <id>${intent.id}</id>
  <name>${intent.name}</name>
  <status>${intent.status}</status>
  <owned_scope>
${scopeLines}
  </owned_scope>
  <constraints>
${constraintLines}
  </constraints>
  <acceptance_criteria>
${criteriaLines}
  </acceptance_criteria>
  <related_requirements>
${relatedLines}
  </related_requirements>
  <directive>
    You MUST only modify files matching the owned_scope globs above.
    Any write outside this scope will be BLOCKED. Request scope expansion
    via the expand_intent_scope tool if needed.
    Classify every file mutation as one of:
    AST_REFACTOR | INTENT_EVOLUTION | BUG_FIX | DOCUMENTATION | TEST | CONFIG
  </directive>
</intent_context>`;
  }

  // ── Intent Map ────────────────────────────────────────────

  /** Append or update an entry in intent_map.md */
  updateIntentMap(
    intentId: string,
    intentName: string,
    files: string[]
  ): void {
    let existing = "";
    if (fs.existsSync(this.intentMapPath)) {
      existing = fs.readFileSync(this.intentMapPath, "utf8");
    }

    const header = `## ${intentId}: ${intentName}`;
    const fileList = files.map((f) => `- \`${f}\``).join("\n");
    const entry = `\n${header}\n_Updated: ${new Date().toISOString()}_\n\n${fileList}\n`;

    // Replace existing entry or append
    const regex = new RegExp(
      `##\\s+${intentId}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`,
      "g"
    );
    const updated = existing.match(regex)
      ? existing.replace(regex, entry)
      : existing + entry;

    fs.mkdirSync(path.dirname(this.intentMapPath), { recursive: true });
    fs.writeFileSync(this.intentMapPath, updated, "utf8");
  }
}