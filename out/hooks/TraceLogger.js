"use strict";
// ============================================================
// TraceLogger.ts — Append-Only AI-Native Git Ledger
// ============================================================
// Purpose: Record every mutating agent action in agent_trace.jsonl.
// Links Business Intent → Code AST Range → Content Hash → Model.
// This is the "Trust Debt repayment" — cryptographic verification
// that every line of code is attributable to a specific intent.
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
exports.TraceLogger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const uuid_1 = require("uuid");
const ContentHasher_1 = require("./ContentHasher");
class TraceLogger {
    constructor(config) {
        this.config = config;
        this.tracePath = path.join(config.orchestrationDir, "agent_trace.jsonl");
    }
    // ── Core Logging ─────────────────────────────────────────
    /**
     * Append a trace entry when a file is written.
     * This is called from the PostHook of write_to_file.
     */
    logFileWrite(params) {
        const { sessionId, intentId, mutationClass, filePath, oldContent, newContent, modelIdentifier, relatedRequirements = [], } = params;
        // Compute changed ranges with spatial hashes
        const ranges = oldContent
            ? ContentHasher_1.ContentHasher.diffLineRanges(oldContent, newContent)
            : [
                {
                    start_line: 1,
                    end_line: newContent.split("\n").length,
                    content_hash: ContentHasher_1.ContentHasher.hashFile(newContent),
                },
            ];
        const relativePath = path.isAbsolute(filePath)
            ? path.relative(this.config.workspaceRoot, filePath)
            : filePath;
        const tracedFile = {
            relative_path: relativePath,
            mutation_class: mutationClass,
            conversations: [
                {
                    url: sessionId,
                    contributor: {
                        entity_type: "AI",
                        model_identifier: modelIdentifier,
                    },
                    ranges,
                    related: [
                        { type: "intent", value: intentId },
                        ...relatedRequirements.map((r) => ({
                            type: "requirement",
                            value: r,
                        })),
                    ],
                },
            ],
        };
        const entry = {
            id: (0, uuid_1.v4)(),
            timestamp: new Date().toISOString(),
            intent_id: intentId,
            vcs: { revision_id: this.getGitSha() },
            files: [tracedFile],
        };
        this.appendEntry(entry);
        return entry;
    }
    /**
     * Log a lesson learned (appended when a linter/test fails).
     */
    logLesson(params) {
        const lessonPath = path.join(this.config.workspaceRoot, "CLAUDE.md");
        const timestamp = new Date().toISOString();
        const entry = [
            "",
            `## Lesson — ${timestamp}`,
            `**Session:** ${params.sessionId}`,
            `**Intent:** ${params.intentId}`,
            `**Failure Type:** ${params.failureType}`,
            "",
            params.lesson,
            "",
        ].join("\n");
        fs.appendFileSync(lessonPath, entry, "utf8");
    }
    // ── Query ─────────────────────────────────────────────────
    /** Load all trace entries for a given intent ID */
    getEntriesForIntent(intentId) {
        if (!fs.existsSync(this.tracePath))
            return [];
        const lines = fs.readFileSync(this.tracePath, "utf8").split("\n").filter(Boolean);
        return lines
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((e) => e !== null && e.intent_id === intentId);
    }
    /** Load all trace entries for a given file path */
    getEntriesForFile(relPath) {
        if (!fs.existsSync(this.tracePath))
            return [];
        const lines = fs.readFileSync(this.tracePath, "utf8").split("\n").filter(Boolean);
        return lines
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((e) => e !== null &&
            e.files.some((f) => f.relative_path === relPath));
    }
    /** Get the last N entries — useful for CLAUDE.md context injection */
    getRecentEntries(n = 10) {
        if (!fs.existsSync(this.tracePath))
            return [];
        const lines = fs
            .readFileSync(this.tracePath, "utf8")
            .split("\n")
            .filter(Boolean);
        return lines
            .slice(-n)
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((e) => e !== null);
    }
    // ── Internal ──────────────────────────────────────────────
    appendEntry(entry) {
        fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
        fs.appendFileSync(this.tracePath, JSON.stringify(entry) + "\n", "utf8");
    }
    getGitSha() {
        try {
            return (0, child_process_1.execSync)("git rev-parse HEAD", {
                cwd: this.config.workspaceRoot,
                timeout: 3000,
            })
                .toString()
                .trim();
        }
        catch {
            return "no-vcs";
        }
    }
}
exports.TraceLogger = TraceLogger;
//# sourceMappingURL=TraceLogger.js.map