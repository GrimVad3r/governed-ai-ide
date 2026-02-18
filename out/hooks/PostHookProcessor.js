"use strict";
// ============================================================
// PostHookProcessor.ts — Run After Tool Execution
// ============================================================
// Purpose: The right gate of the middleware boundary.
//   1. Write trace entries to agent_trace.jsonl
//   2. Update intent_map.md with file→intent mappings
//   3. Snapshot new file hashes for concurrency tracking
//   4. Record lessons if verification fails
//   5. Update intent status on completion signals
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostHookProcessor = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const CommandClassifier_1 = require("./CommandClassifier");
const ConcurrencyGuard_1 = require("./ConcurrencyGuard");
const ContentHasher_1 = require("./ContentHasher");
class PostHookProcessor {
    constructor(config, traceLogger, intentManager, stateMachine) {
        this.config = config;
        this.traceLogger = traceLogger;
        this.intentManager = intentManager;
        this.stateMachine = stateMachine;
    }
    // ── Main Entry Point ─────────────────────────────────────
    async process(ctx) {
        const { toolName, parameters, sessionId } = ctx;
        const session = this.stateMachine.getSession(sessionId);
        // ── File Read — snapshot for concurrency tracking ─────
        if (toolName === "read_file" || toolName === "read_content") {
            this.handleReadSnapshot(parameters, sessionId);
            return;
        }
        // ── File Write — trace + map update ──────────────────
        if (CommandClassifier_1.CommandClassifier.isMutating(toolName) && session?.activeIntentId) {
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
    async handleWritePost(ctx) {
        const { toolName, parameters, sessionId, mutationClass } = ctx;
        const session = this.stateMachine.getSession(sessionId);
        if (!session?.activeIntentId || !session.activeIntent)
            return;
        const intentId = session.activeIntentId;
        const filePath = CommandClassifier_1.CommandClassifier.extractTargetPath(toolName, parameters);
        if (!filePath)
            return;
        const absolutePath = this.resolveAbsolute(filePath);
        const relPath = path.relative(this.config.workspaceRoot, absolutePath);
        // Read current content from disk (just written)
        let newContent = "";
        try {
            newContent = fs.readFileSync(absolutePath, "utf8");
        }
        catch {
            newContent = (CommandClassifier_1.CommandClassifier.extractContent(toolName, parameters)) ?? "";
        }
        // Read old content from snapshot or use empty string for new files
        const oldHash = this.stateMachine.getSnapshot(sessionId, absolutePath);
        let oldContent = null;
        if (oldHash) {
            // We don't store old content directly; use parameter if available
            // For accurate diff, the agent should pass previous content
            oldContent = parameters["old_content"] ?? null;
        }
        // Determine mutation class
        const finalMutationClass = mutationClass ??
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
        this.intentManager.updateIntentMap(intentId, session.activeIntent.name, existingFiles);
        // Update post-write snapshot for next concurrency check
        const newHash = ContentHasher_1.ContentHasher.hashFile(newContent);
        this.stateMachine.snapshotFile(sessionId, absolutePath, newHash);
    }
    handleReadSnapshot(parameters, sessionId) {
        const filePath = CommandClassifier_1.CommandClassifier.extractTargetPath("read_file", parameters);
        if (!filePath)
            return;
        const absolutePath = this.resolveAbsolute(filePath);
        const hash = ConcurrencyGuard_1.ConcurrencyGuard.snapshotOnRead(absolutePath);
        if (hash) {
            this.stateMachine.snapshotFile(sessionId, absolutePath, hash);
        }
    }
    // ── Helpers ──────────────────────────────────────────────
    resolveAbsolute(filePath) {
        if (path.isAbsolute(filePath))
            return filePath;
        return path.join(this.config.workspaceRoot, filePath);
    }
    inferMutationClass(toolName, parameters, filePath, intentName) {
        if (filePath.match(/\.(test|spec)\.(ts|js|tsx|jsx)$/))
            return "TEST";
        if (filePath.match(/\.(md|txt|rst)$/i))
            return "DOCUMENTATION";
        if (filePath.match(/(package\.json|tsconfig|\.yml|\.yaml|Dockerfile)$/i))
            return "CONFIG";
        const content = CommandClassifier_1.CommandClassifier.extractContent(toolName, parameters) ?? "";
        if (content.includes("// fix") || content.includes("// bug"))
            return "BUG_FIX";
        return "AST_REFACTOR";
    }
    inferFailureType(reason) {
        if (reason.includes("lint") || reason.includes("eslint"))
            return "lint";
        if (reason.includes("test") || reason.includes("jest") || reason.includes("mocha"))
            return "test";
        if (reason.includes("build") || reason.includes("compile"))
            return "build";
        if (reason.includes("scope"))
            return "scope_violation";
        return "other";
    }
    getExistingMappedFiles(intentId) {
        const intentMapPath = path.join(this.config.orchestrationDir, "intent_map.md");
        if (!fs.existsSync(intentMapPath))
            return [];
        const content = fs.readFileSync(intentMapPath, "utf8");
        const regex = new RegExp(`##\\s+${intentId}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`, "g");
        const section = content.match(regex)?.[0] ?? "";
        const fileMatches = section.matchAll(/- `([^`]+)`/g);
        return Array.from(fileMatches).map((m) => m[1]);
    }
}
exports.PostHookProcessor = PostHookProcessor;
//# sourceMappingURL=PostHookProcessor.js.map