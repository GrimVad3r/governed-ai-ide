// ============================================================
// TraceLogger.ts — Append-Only AI-Native Git Ledger
// ============================================================
// Purpose: Record every mutating agent action in agent_trace.jsonl.
// Links Business Intent → Code AST Range → Content Hash → Model.
// This is the "Trust Debt repayment" — cryptographic verification
// that every line of code is attributable to a specific intent.

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { ContentHasher } from "./ContentHasher";
import {
  AgentTraceEntry,
  MutationClass,
  HookEngineConfig,
  TracedFile,
} from "./types";

export class TraceLogger {
  private readonly tracePath: string;
  private config: HookEngineConfig;

  constructor(config: HookEngineConfig) {
    this.config = config;
    this.tracePath = path.join(config.orchestrationDir, "agent_trace.jsonl");
  }

  // ── Core Logging ─────────────────────────────────────────

  /**
   * Append a trace entry when a file is written.
   * This is called from the PostHook of write_to_file.
   */
  logFileWrite(params: {
    sessionId: string;
    intentId: string;
    mutationClass: MutationClass;
    filePath: string;
    oldContent: string | null;
    newContent: string;
    modelIdentifier: string;
    relatedRequirements?: string[];
  }): AgentTraceEntry {
    const {
      sessionId,
      intentId,
      mutationClass,
      filePath,
      oldContent,
      newContent,
      modelIdentifier,
      relatedRequirements = [],
    } = params;

    // Compute changed ranges with spatial hashes
    const ranges = oldContent
      ? ContentHasher.diffLineRanges(oldContent, newContent)
      : [
          {
            startLine: 1,
            endLine: newContent.split("\n").length,
            content_hash: ContentHasher.hashFile(newContent),
          },
        ];

    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.config.workspaceRoot, filePath)
      : filePath;

    const tracedFile: TracedFile = {
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
              type: "requirement" as const,
              value: r,
            })),
          ],
        },
      ],
    };

    const entry: AgentTraceEntry = {
      id: uuidv4(),
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
  logLesson(params: {
    sessionId: string;
    intentId: string;
    lesson: string;
    failureType: "lint" | "test" | "build" | "scope_violation" | "other";
  }): void {
    const lessonPath = path.join(
      this.config.workspaceRoot,
      "CLAUDE.md"
    );

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
  getEntriesForIntent(intentId: string): AgentTraceEntry[] {
    if (!fs.existsSync(this.tracePath)) return [];
    const lines = fs.readFileSync(this.tracePath, "utf8").split("\n").filter(Boolean);
    return lines
      .map((l) => {
        try {
          return JSON.parse(l) as AgentTraceEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AgentTraceEntry => e !== null && e.intent_id === intentId);
  }

  /** Load all trace entries for a given file path */
  getEntriesForFile(relPath: string): AgentTraceEntry[] {
    if (!fs.existsSync(this.tracePath)) return [];
    const lines = fs.readFileSync(this.tracePath, "utf8").split("\n").filter(Boolean);
    return lines
      .map((l) => {
        try {
          return JSON.parse(l) as AgentTraceEntry;
        } catch {
          return null;
        }
      })
      .filter(
        (e): e is AgentTraceEntry =>
          e !== null &&
          e.files.some((f) => f.relative_path === relPath)
      );
  }

  /** Get the last N entries — useful for CLAUDE.md context injection */
  getRecentEntries(n = 10): AgentTraceEntry[] {
    if (!fs.existsSync(this.tracePath)) return [];
    const lines = fs
      .readFileSync(this.tracePath, "utf8")
      .split("\n")
      .filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l) as AgentTraceEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AgentTraceEntry => e !== null);
  }

  // ── Internal ──────────────────────────────────────────────

  private appendEntry(entry: AgentTraceEntry): void {
    fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
    fs.appendFileSync(this.tracePath, JSON.stringify(entry) + "\n", "utf8");
  }

  private getGitSha(): string {
    try {
      return execSync("git rev-parse HEAD", {
        cwd: this.config.workspaceRoot,
        timeout: 3000,
      })
        .toString()
        .trim();
    } catch {
      return "no-vcs";
    }
  }
}