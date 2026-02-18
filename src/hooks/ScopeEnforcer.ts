// ============================================================
// ScopeEnforcer.ts — Scope and .intentignore Enforcement
// ============================================================
// Purpose: Prevent agents from writing outside their declared
// intent's owned_scope. Also reads .intentignore to exclude
// globally protected paths from ALL intent mutations.

import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";
import { IntentManager } from "./IntentManager";
import { HookError, HookEngineConfig } from "./types";

export class ScopeEnforcer {
  private intentManager: IntentManager;
  private config: HookEngineConfig;
  private ignoredPatterns: string[] = [];

  constructor(config: HookEngineConfig, intentManager: IntentManager) {
    this.config = config;
    this.intentManager = intentManager;
    this.loadIntentIgnore();
  }

  // ── .intentignore ─────────────────────────────────────────

  /**
   * Load .intentignore from orchestration dir.
   * Format is identical to .gitignore — one glob per line.
   * Files matching these patterns are NEVER modifiable by any intent.
   */
  private loadIntentIgnore(): void {
    const ignorePath = path.join(
      this.config.orchestrationDir,
      ".intentignore"
    );
    if (!fs.existsSync(ignorePath)) {
      this.ignoredPatterns = [];
      return;
    }
    const raw = fs.readFileSync(ignorePath, "utf8");
    this.ignoredPatterns = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  private isIgnored(relPath: string): boolean {
    return this.ignoredPatterns.some((pattern) =>
      minimatch(relPath, pattern, { matchBase: true, dot: true })
    );
  }

  // ── Main Enforcement ─────────────────────────────────────

  /**
   * Validate that a write to `filePath` is allowed for `intentId`.
   * Returns null if allowed, or a HookError if blocked.
   */
  enforce(intentId: string, filePath: string): HookError | null {
    const relPath = path.isAbsolute(filePath)
      ? path.relative(this.config.workspaceRoot, filePath)
      : filePath;

    // Check .intentignore first (global protection)
    if (this.isIgnored(relPath)) {
      return {
        code: "INTENTIGNORE_MATCH",
        message: `File ${relPath} is protected by .intentignore and cannot be modified.`,
        recoveryHint:
          `The file ${relPath} matches a pattern in .intentignore and is globally protected. ` +
          "Do not attempt to modify this file. Find an alternative approach that does not " +
          "require touching protected infrastructure files.",
      };
    }

    // Then check intent scope
    const inScope = this.intentManager.isFileInScope(intentId, relPath);
    if (!inScope) {
      const intent = this.intentManager.getById(intentId);
      const scopeStr = intent?.owned_scope.join(", ") ?? "unknown";
      return {
        code: "SCOPE_VIOLATION",
        message: `Scope Violation: ${intentId} is not authorized to edit '${relPath}'. Allowed scope: ${scopeStr}`,
        recoveryHint:
          `You attempted to write to '${relPath}' but ${intentId} only owns: ${scopeStr}. ` +
          "Options: (1) Restrict your changes to files within the owned_scope. " +
          "(2) Call expand_intent_scope to request scope expansion (requires human approval). " +
          "(3) Create a new intent for this file if it represents a separate concern.",
      };
    }

    return null; // ✓ Allowed
  }

  /** Reload .intentignore (call when the file changes on disk) */
  reload(): void {
    this.loadIntentIgnore();
  }

  getIgnoredPatterns(): string[] {
    return [...this.ignoredPatterns];
  }
}