"use strict";
// ============================================================
// ConcurrencyGuard.ts — Optimistic Locking for Parallel Agents
// ============================================================
// Purpose: Prevent two parallel agent sessions (e.g. Architect
// and Builder) from overwriting each other's changes. Implements
// optimistic locking via content hashing — no file locks needed.
//
// Protocol:
//   1. When an agent READs a file → snapshot its hash.
//   2. When an agent WRITEs a file → compare current disk hash
//      to the snapshot taken at read-time.
//   3. If they differ → another agent (or human) modified the file.
//      BLOCK the write and return a STALE_FILE error.
//   4. The blocked agent must re-read the file and merge changes.
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
exports.ConcurrencyGuard = void 0;
const fs = __importStar(require("fs"));
const ContentHasher_1 = require("./ContentHasher");
class ConcurrencyGuard {
    /**
     * Compute the current hash of a file on disk.
     * Returns null if the file does not exist.
     */
    static getCurrentHash(absolutePath) {
        if (!fs.existsSync(absolutePath))
            return null;
        const contents = fs.readFileSync(absolutePath, "utf8");
        return ContentHasher_1.ContentHasher.hashFile(contents);
    }
    /**
     * Validate that a file has not been modified since the agent
     * last read it. Pass the hash that was captured at read-time.
     *
     * Returns null if safe to proceed, or a HookError if stale.
     */
    static validateWrite(absolutePath, snapshotHash) {
        // File is new — no conflict possible
        if (snapshotHash === null)
            return null;
        const currentHash = ConcurrencyGuard.getCurrentHash(absolutePath);
        // File was deleted by another agent — treat as conflict
        if (currentHash === null) {
            return {
                code: "CONCURRENCY_CONFLICT",
                message: `File ${absolutePath} was deleted by another agent since you read it.`,
                recoveryHint: "The file you are trying to modify has been deleted. " +
                    "Re-read the current directory structure and adjust your plan. " +
                    "Do not re-attempt this write without re-reading.",
            };
        }
        // Hash mismatch → stale
        if (!ContentHasher_1.ContentHasher.compare(snapshotHash, currentHash)) {
            return {
                code: "STALE_FILE",
                message: `Concurrency conflict on ${absolutePath}. File was modified by another agent.`,
                recoveryHint: "Another agent or user has modified this file since you read it. " +
                    "You MUST call read_file to get the latest version, then re-plan " +
                    "your changes to incorporate the new content before writing.",
            };
        }
        return null; // All clear
    }
    /**
     * Build the snapshot hash for a file that an agent is about to read.
     * Call this in the PostHook of read_file so the session can track it.
     */
    static snapshotOnRead(absolutePath) {
        return ConcurrencyGuard.getCurrentHash(absolutePath);
    }
}
exports.ConcurrencyGuard = ConcurrencyGuard;
//# sourceMappingURL=ConcurrencyGuard.js.map