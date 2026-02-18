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

import * as fs from "fs";
import { ContentHasher } from "./ContentHasher";
import { HookError } from "./types";

export class ConcurrencyGuard {
  /**
   * Compute the current hash of a file on disk.
   * Returns null if the file does not exist.
   */
  static getCurrentHash(absolutePath: string): string | null {
    if (!fs.existsSync(absolutePath)) return null;
    const contents = fs.readFileSync(absolutePath, "utf8");
    return ContentHasher.hashFile(contents);
  }

  /**
   * Validate that a file has not been modified since the agent
   * last read it. Pass the hash that was captured at read-time.
   *
   * Returns null if safe to proceed, or a HookError if stale.
   */
  static validateWrite(
    absolutePath: string,
    snapshotHash: string | null
  ): HookError | null {
    // File is new — no conflict possible
    if (snapshotHash === null) return null;

    const currentHash = ConcurrencyGuard.getCurrentHash(absolutePath);

    // File was deleted by another agent — treat as conflict
    if (currentHash === null) {
      return {
        code: "CONCURRENCY_CONFLICT",
        message: `File ${absolutePath} was deleted by another agent since you read it.`,
        recoveryHint:
          "The file you are trying to modify has been deleted. " +
          "Re-read the current directory structure and adjust your plan. " +
          "Do not re-attempt this write without re-reading.",
      };
    }

    // Hash mismatch → stale
    if (!ContentHasher.compare(snapshotHash, currentHash)) {
      return {
        code: "STALE_FILE",
        message: `Concurrency conflict on ${absolutePath}. File was modified by another agent.`,
        recoveryHint:
          "Another agent or user has modified this file since you read it. " +
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
  static snapshotOnRead(absolutePath: string): string | null {
    return ConcurrencyGuard.getCurrentHash(absolutePath);
  }
}