// ============================================================
// PostHookProcessor.ts — Run After Tool Execution
// ============================================================
// Purpose: The right gate of the middleware boundary.
//   1. Write trace entries to agent_trace.jsonl
//   2. Update intent_map.md with file→intent mappings
//   3. Snapshot new file hashes for concurrency tracking
//   4. Record lessons if verification fails
//   5. Update intent status on completion signals

import * as fs from "fs";
import * as path from "path";
import { TraceLogger } from "./TraceLogger";
import { IntentManager } from "./IntentManager";
import { StateMachine } from "./StateMachine";
import { CommandClassifier } from "./CommandClassifier";
import { ConcurrencyGuard } from "./ConcurrencyGuard";
import { ContentHasher } from "./ContentHasher";
import { HookEngineConfig, MutationClass } from "./types";

export interface PostHookContext {
  toolName: string;
  parameters: Record<string, unknown>;
  result: unknown;                  // Whatever the tool returned
  sessionId: string;
  mutationClass?: MutationClass;
  verificationFailed?: boolean;
  verificationFailureReason?: string;
  lessonLearned?: string;
}

export class PostHookProcessor {
  private traceLogger: TraceLogger;
  private intentManager: IntentManager;
  private stateMachine: StateMachine;
  private config: HookEngineConfig;

  constructor(
    config: HookEngineConfig,
    traceLogger: TraceLogger,
    intentManager: IntentManager,
    stateMachine: StateMachine
  ) {
    this.config = config;
    this.traceLogger = traceLogger;
    this.intentManager = intentManager;
    this.stateMachine = stateMachine;
  }

  // ── Main Entry Point ─────────────────────────────────────

  async process(ctx: PostHookContext): Promise<void> {
    const { toolName, parameters, sessionId } = ctx;
    const session = this.stateMachine.getSession(sessionId);

    // ── File Read — snapshot for concurrency tracking ─────
    if (toolName === "read_file" || toolName === "read_content") {
      this.handleReadSnapshot(parameters, sessionId);
      return;
    }

    // ── File Write — trace + map update ──────────────────
    if (CommandClassifier.isMutating(toolName) && session?.activeIntentId) {
      await this.handleWritePost(ctx);
    }

    // ── Verification failure — record lesson ──────────────
    if (ctx.verificationFailed && ctx.lessonLearned && session?.activeIntentId) {
      this.traceLogger.logLesson({
        sessionId,
        intentId: session.activeIntentId,
        lesson: ctx.lessonLearned,
        failureType: this.inferFailureType(ctx.verificationFailureReason ?? ""),
      });
    }
  }

  // ── Private Handlers ─────────────────────────────────────

  private async handleWritePost(ctx: PostHookContext): Promise<void> {
    const { toolName, parameters, sessionId, mutationClass } = ctx;
    const session = this.stateMachine.getSession(sessionId);
    if (!session?.activeIntentId || !session.activeIntent) return;

    const intentId = session.activeIntentId;
    const filePath = CommandClassifier.extractTargetPath(toolName, parameters);
    if (!filePath) return;

    const absolutePath = this.resolveAbsolute(filePath);
    const relPath = path.relative(this.config.workspaceRoot, absolutePath);

    // Read current content from disk (just written)
    let newContent = "";
    try {
      newContent = fs.readFileSync(absolutePath, "utf8");
    } catch {
      newContent = (CommandClassifier.extractContent(toolName, parameters)) ?? "";
    }

    // Read old content from snapshot or use empty string for new files
    const oldHash = this.stateMachine.getSnapshot(sessionId, absolutePath);
    let oldContent: string | null = null;
    if (oldHash) {
      // We don't store old content directly; use parameter if available
      // For accurate diff, the agent should pass previous content
      oldContent = (parameters["old_content"] as string) ?? null;
    }

    // Determine mutation class
    const finalMutationClass: MutationClass =
      mutationClass ??
      this.inferMutationClass(toolName, parameters, filePath, session.activeIntent.name);

    // Write trace entry
    this.traceLogger.logFileWrite({
      sessionId,
      intentId,
      mutationClass: finalMutationClass,
      filePath: absolutePath,
      oldContent,
      newContent,
      modelIdentifier: this.config.modelIdentifier ?? "claude-sonnet-4-6",
      relatedRequirements: session.activeIntent.related_requirements ?? [],
    });

    // Update intent_map.md
    const existingFiles = this.getExistingMappedFiles(intentId);
    if (!existingFiles.includes(relPath)) {
      existingFiles.push(relPath);
    }
    this.intentManager.updateIntentMap(
      intentId,
      session.activeIntent.name,
      existingFiles
    );

    // Update post-write snapshot for next concurrency check
    const newHash = ContentHasher.hashFile(newContent);
    this.stateMachine.snapshotFile(sessionId, absolutePath, newHash);
  }

  private handleReadSnapshot(
    parameters: Record<string, unknown>,
    sessionId: string
  ): void {
    const filePath = CommandClassifier.extractTargetPath("read_file", parameters);
    if (!filePath) return;
    const absolutePath = this.resolveAbsolute(filePath);
    const hash = ConcurrencyGuard.snapshotOnRead(absolutePath);
    if (hash) {
      this.stateMachine.snapshotFile(sessionId, absolutePath, hash);
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private resolveAbsolute(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(this.config.workspaceRoot, filePath);
  }

  private inferMutationClass(
    toolName: string,
    parameters: Record<string, unknown>,
    filePath: string,
    intentName: string
  ): MutationClass {
    if (filePath.match(/\.(test|spec)\.(ts|js|tsx|jsx)$/)) return "TEST";
    if (filePath.match(/\.(md|txt|rst)$/i)) return "DOCUMENTATION";
    if (
      filePath.match(/(package\.json|tsconfig|\.yml|\.yaml|Dockerfile)$/i)
    )
      return "CONFIG";
    const content = CommandClassifier.extractContent(toolName, parameters) ?? "";
    if (content.includes("// fix") || content.includes("// bug"))
      return "BUG_FIX";
    return "AST_REFACTOR";
  }

  private inferFailureType(
    reason: string
  ): "lint" | "test" | "build" | "scope_violation" | "other" {
    if (reason.includes("lint") || reason.includes("eslint")) return "lint";
    if (reason.includes("test") || reason.includes("jest") || reason.includes("mocha"))
      return "test";
    if (reason.includes("build") || reason.includes("compile")) return "build";
    if (reason.includes("scope")) return "scope_violation";
    return "other";
  }

  private getExistingMappedFiles(intentId: string): string[] {
    const intentMapPath = path.join(
      this.config.orchestrationDir,
      "intent_map.md"
    );
    if (!fs.existsSync(intentMapPath)) return [];
    const content = fs.readFileSync(intentMapPath, "utf8");
    const regex = new RegExp(
      `##\\s+${intentId}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`,
      "g"
    );
    const section = content.match(regex)?.[0] ?? "";
    const fileMatches = section.matchAll(/- `([^`]+)`/g);
    return Array.from(fileMatches).map((m) => m[1]);
  }
}