"use strict";
// ============================================================
// ScopeEnforcer.ts — Scope and .intentignore Enforcement
// ============================================================
// Purpose: Prevent agents from writing outside their declared
// intent's owned_scope. Also reads .intentignore to exclude
// globally protected paths from ALL intent mutations.
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
exports.ScopeEnforcer = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const minimatch_1 = require("minimatch");
class ScopeEnforcer {
    constructor(config, intentManager) {
        this.ignoredPatterns = [];
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
    loadIntentIgnore() {
        const ignorePath = path.join(this.config.orchestrationDir, ".intentignore");
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
    isIgnored(relPath) {
        return this.ignoredPatterns.some((pattern) => (0, minimatch_1.minimatch)(relPath, pattern, { matchBase: true, dot: true }));
    }
    // ── Main Enforcement ─────────────────────────────────────
    /**
     * Validate that a write to `filePath` is allowed for `intentId`.
     * Returns null if allowed, or a HookError if blocked.
     */
    enforce(intentId, filePath) {
        const relPath = path.isAbsolute(filePath)
            ? path.relative(this.config.workspaceRoot, filePath)
            : filePath;
        // Check .intentignore first (global protection)
        if (this.isIgnored(relPath)) {
            return {
                code: "INTENTIGNORE_MATCH",
                message: `File ${relPath} is protected by .intentignore and cannot be modified.`,
                recoveryHint: `The file ${relPath} matches a pattern in .intentignore and is globally protected. ` +
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
                recoveryHint: `You attempted to write to '${relPath}' but ${intentId} only owns: ${scopeStr}. ` +
                    "Options: (1) Restrict your changes to files within the owned_scope. " +
                    "(2) Call expand_intent_scope to request scope expansion (requires human approval). " +
                    "(3) Create a new intent for this file if it represents a separate concern.",
            };
        }
        return null; // ✓ Allowed
    }
    /** Reload .intentignore (call when the file changes on disk) */
    reload() {
        this.loadIntentIgnore();
    }
    getIgnoredPatterns() {
        return [...this.ignoredPatterns];
    }
}
exports.ScopeEnforcer = ScopeEnforcer;
//# sourceMappingURL=ScopeEnforcer.js.map