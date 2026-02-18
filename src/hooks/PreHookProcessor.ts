// ============================================================
// PreHookProcessor.ts — Intercept Tool Calls BEFORE Execution
// ============================================================
// Purpose: The left gate of the middleware boundary.
//   1. Validate intent declaration (no intent → block)
//   2. Inject intent context into the prompt
//   3. Enforce scope on write operations
//   4. Validate optimistic lock (no stale files)
//   5. Classify command risk and gate HITL approval

import * as fs from "fs";
import { IntentManager } from "./IntentManager";
import { StateMachine } from "./StateMachine";
import { ScopeEnforcer } from "./ScopeEnforcer";
import { ConcurrencyGuard } from "./ConcurrencyGuard";
import { CommandClassifier } from "./CommandClassifier";
import { TraceLogger } from "./TraceLogger";
import {
  ToolCallRequest,
  ToolCallResult,
  HookEngineConfig,
  MutationClass,
  ActiveIntent,
} from "./types";

// ── HITL Callback Type ────────────────────────────────────
// The VS Code UI layer injects this function so the hook
// can trigger a native warning dialog without importing vscode
// directly (keeps the hook engine testable outside VS Code).
export type HITLApprovalFn = (message: string) => Promise<boolean>;

export class PreHookProcessor {
  private intentManager: IntentManager;
  private stateMachine: StateMachine;
  private scopeEnforcer: ScopeEnforcer;
  private concurrencyGuard: typeof ConcurrencyGuard;
  private traceLogger: TraceLogger;
  private config: HookEngineConfig;
  private requestHITLApproval: HITLApprovalFn;

  constructor(
    config: HookEngineConfig,
    intentManager: IntentManager,
    stateMachine: StateMachine,
    scopeEnforcer: ScopeEnforcer,
    traceLogger: TraceLogger,
    requestHITLApproval: HITLApprovalFn
  ) {
    this.config = config;
    this.intentManager = intentManager;
    this.stateMachine = stateMachine;
    this.scopeEnforcer = scopeEnforcer;
    this.concurrencyGuard = ConcurrencyGuard;
    this.traceLogger = traceLogger;
    this.requestHITLApproval = requestHITLApproval;
  }

  // ── Main Entry Point ─────────────────────────────────────

  async process(request: ToolCallRequest): Promise<ToolCallResult> {
    const { toolName, parameters, sessionId } = request;

    // ── 1. Handle the Handshake Tool ─────────────────────
    if (toolName === "select_active_intent") {
      return await this.handleSelectIntent(request);
    }

    // ── 2. Safe reads bypass most checks ─────────────────
    const risk = CommandClassifier.classify(toolName, parameters);
    if (risk === "SAFE") {
      // But still snapshot file hashes for concurrency tracking
      this.snapshotIfReadFile(toolName, parameters, sessionId);
      return { allowed: true };
    }

    // ── 3. Enforce intent declaration ─────────────────────
    const session = this.stateMachine.getOrCreate(sessionId);
    if (session.phase !== "INTENT_LOADED") {
      this.stateMachine.transitionToBlocked(sessionId);
      return {
        allowed: false,
        error: {
          code: "NO_ACTIVE_INTENT",
          message: "No active intent declared. Cannot execute mutating actions.",
          recoveryHint:
            "You MUST call select_active_intent(intent_id) before making any " +
            "file writes or executing commands. Analyze the user's request, " +
            "identify the correct intent ID from active_intents.yaml, and call " +
            "select_active_intent first.",
        },
      };
    }

    const activeIntent = session.activeIntent!;

    // ── 4. Scope enforcement for file writes ──────────────
    if (CommandClassifier.isMutating(toolName)) {
      const targetPath = CommandClassifier.extractTargetPath(toolName, parameters);
      if (targetPath && this.config.enableScopeEnforcement) {
        const scopeError = this.scopeEnforcer.enforce(activeIntent.id, targetPath);
        if (scopeError) {
          this.stateMachine.transitionToBlocked(sessionId);
          return { allowed: false, error: scopeError };
        }
      }
    }

    // ── 5. Optimistic lock check ──────────────────────────
    if (this.config.enableConcurrencyGuard && CommandClassifier.isMutating(toolName)) {
      const targetPath = CommandClassifier.extractTargetPath(toolName, parameters);
      if (targetPath) {
        const absolutePath = this.resolveAbsolute(targetPath);
        const snapshot = this.stateMachine.getSnapshot(sessionId, absolutePath);
        const lockError = this.concurrencyGuard.validateWrite(absolutePath, snapshot);
        if (lockError) {
          return { allowed: false, error: lockError };
        }
      }
    }

    // ── 6. HITL gate for ELEVATED / DESTRUCTIVE commands ──
    if (this.config.enableHITL) {
      if (risk === "ELEVATED") {
        const cmd =
          (parameters["command"] as string) ||
          CommandClassifier.extractTargetPath(toolName, parameters) ||
          toolName;

        const approved = await this.requestHITLApproval(
          `⚠️ ELEVATED RISK ACTION\n\nIntent: ${activeIntent.id} — ${activeIntent.name}\nTool: ${toolName}\nCommand: ${cmd}\n\nApprove this action?`
        );

        if (!approved) {
          return {
            allowed: false,
            error: {
              code: "HITL_REJECTED",
              message: `Human rejected elevated action: ${toolName}`,
              recoveryHint:
                "The human reviewer rejected this action. Reconsider your approach. " +
                "Find a less invasive way to achieve the same goal. " +
                "If a shell command is necessary, explain why before re-attempting.",
            },
          };
        }
      }

      // Intent evolution (writing outside normal flow) requires approval
      const mutationClass = this.inferMutationClass(
        toolName,
        parameters,
        activeIntent
      );
      if (mutationClass === "INTENT_EVOLUTION" && risk === "DESTRUCTIVE") {
        const filePath =
          CommandClassifier.extractTargetPath(toolName, parameters) ?? "unknown";
        const approved = await this.requestHITLApproval(
          `🔄 INTENT EVOLUTION DETECTED\n\nIntent: ${activeIntent.id} — ${activeIntent.name}\nFile: ${filePath}\n\nThis write appears to EXTEND scope, not just refactor. Approve?`
        );
        if (!approved) {
          return {
            allowed: false,
            error: {
              code: "HITL_REJECTED",
              message: "Intent evolution rejected by human reviewer.",
              recoveryHint:
                "The human rejected this scope expansion. Limit your changes to " +
                "the existing intent scope, or create a new intent for this new feature.",
            },
          };
        }
      }
    }

    return { allowed: true };
  }

  // ── Handshake Handler ────────────────────────────────────

  private async handleSelectIntent(
    request: ToolCallRequest
  ): Promise<ToolCallResult> {
    const { parameters, sessionId } = request;
    const intentId = (parameters["intent_id"] as string) ?? "";

    if (!intentId) {
      return {
        allowed: false,
        error: {
          code: "INVALID_INTENT_ID",
          message: "select_active_intent requires an intent_id parameter.",
          recoveryHint:
            "Call select_active_intent with a valid intent_id string, " +
            "e.g. select_active_intent(intent_id='INT-001').",
        },
      };
    }

    if (!this.intentManager.isValidIntent(intentId)) {
      return {
        allowed: false,
        error: {
          code: "INVALID_INTENT_ID",
          message: `Intent '${intentId}' does not exist or is not actionable (may be COMPLETE or ABANDONED).`,
          recoveryHint:
            `'${intentId}' is not a valid active intent. ` +
            "Read active_intents.yaml to find available intent IDs. " +
            "Only use IDs with status: PENDING or IN_PROGRESS.",
        },
      };
    }

    const intent = this.intentManager.getById(intentId)!;
    this.stateMachine.transitionToLoaded(sessionId, intent);
    this.intentManager.markInProgress(intentId);

    // Build the XML context block to inject into the LLM prompt
    const contextBlock = this.intentManager.buildContextBlock(intentId);

    // Also attach recent trace history for this intent
    const recentTrace = this.traceLogger
      .getEntriesForIntent(intentId)
      .slice(-5)
      .map(
        (e) =>
          `  [${e.timestamp}] ${e.files[0]?.relative_path ?? "?"} — ${e.files[0]?.mutation_class ?? "?"}`
      )
      .join("\n");

    const injectedContext =
      contextBlock +
      (recentTrace
        ? `\n<recent_trace_history>\n${recentTrace}\n</recent_trace_history>`
        : "");

    return {
      allowed: true,
      injectedContext,
    };
  }

  // ── Helpers ──────────────────────────────────────────────

  private snapshotIfReadFile(
    toolName: string,
    parameters: Record<string, unknown>,
    sessionId: string
  ): void {
    if (toolName === "read_file" || toolName === "read_content") {
      const filePath = CommandClassifier.extractTargetPath(toolName, parameters);
      if (filePath) {
        const absolutePath = this.resolveAbsolute(filePath);
        const hash = ConcurrencyGuard.snapshotOnRead(absolutePath);
        if (hash) {
          this.stateMachine.snapshotFile(sessionId, absolutePath, hash);
        }
      }
    }
  }

  private resolveAbsolute(filePath: string): string {
    if (require("path").isAbsolute(filePath)) return filePath;
    return require("path").join(this.config.workspaceRoot, filePath);
  }

  private inferMutationClass(
    toolName: string,
    parameters: Record<string, unknown>,
    activeIntent: ActiveIntent
  ): MutationClass {
    // Heuristic: if content contains new exports/classes not in the intent name, likely INTENT_EVOLUTION
    const content = CommandClassifier.extractContent(toolName, parameters);
    if (!content) return "UNKNOWN";

    // Test file pattern
    const filePath = CommandClassifier.extractTargetPath(toolName, parameters) ?? "";
    if (filePath.includes("test") || filePath.includes("spec")) return "TEST";
    if (filePath.includes(".md") || filePath.includes("README")) return "DOCUMENTATION";
    if (
      filePath.includes("package.json") ||
      filePath.includes("tsconfig") ||
      filePath.includes(".yaml")
    )
      return "CONFIG";

    // If content introduces new exported functions not related to intent name → EVOLUTION
    const newExports = (content.match(/export\s+(function|class|const)\s+(\w+)/g) ?? [])
      .map((m) => m.split(/\s+/).pop() ?? "")
      .filter(Boolean);

    const intentKeywords = activeIntent.name.toLowerCase().split(/\s+/);
    const hasUnrelatedExport = newExports.some(
      (exp) =>
        !intentKeywords.some((kw) => exp.toLowerCase().includes(kw))
    );

    return hasUnrelatedExport ? "INTENT_EVOLUTION" : "AST_REFACTOR";
  }
}