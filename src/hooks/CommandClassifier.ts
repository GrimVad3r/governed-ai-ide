// ============================================================
// CommandClassifier.ts — Classify Tool Calls by Risk Level
// ============================================================
// Purpose: Determine whether a tool call is SAFE (read-only),
// DESTRUCTIVE (mutates state), or ELEVATED (system-level risk).
// This classification drives the HITL approval gate.

import { CommandRisk } from "./types";

// Tools that only READ — no HITL required
const SAFE_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "get_diagnostics",
  "list_code_definition_names",
  "select_active_intent",    // the handshake — always safe
  "get_intent_context",
  "list_intents",
]);

// Tools that WRITE or DELETE — require intent check + possible HITL
const DESTRUCTIVE_TOOLS = new Set([
  "write_to_file",
  "apply_diff",
  "insert_content",
  "search_and_replace",
  "create_file",
  "delete_file",
  "rename_file",
]);

// Tools that EXECUTE shell commands — highest risk, always HITL
const ELEVATED_TOOLS = new Set([
  "execute_command",
  "run_terminal_command",
  "browser_action",
  "spawn_agent",
]);

// Dangerous shell patterns that upgrade a "safe" command to ELEVATED
const DANGEROUS_SHELL_PATTERNS = [
  /rm\s+-rf/,
  /sudo\s+/,
  /chmod\s+777/,
  /curl\s+.*\|.*sh/,
  /wget\s+.*\|.*sh/,
  />\s*\/etc\//,
  /dd\s+if=/,
  /mkfs/,
  /shutdown/,
  /reboot/,
  /\$\(.*\)/,      // command substitution
];

export class CommandClassifier {
  /**
   * Classify a tool call by name and parameters.
   * Returns SAFE | DESTRUCTIVE | ELEVATED
   */
  static classify(
    toolName: string,
    parameters: Record<string, unknown>
  ): CommandRisk {
    const normalized = toolName.toLowerCase().replace(/[-_]/g, "_");

    if (ELEVATED_TOOLS.has(normalized)) {
      return "ELEVATED";
    }

    if (DESTRUCTIVE_TOOLS.has(normalized)) {
      return "DESTRUCTIVE";
    }

    // Check execute_command content for dangerous patterns
    if (normalized === "execute_command" || normalized === "run_terminal_command") {
      const cmd = (parameters["command"] as string) ?? "";
      const isDangerous = DANGEROUS_SHELL_PATTERNS.some((p) => p.test(cmd));
      return isDangerous ? "ELEVATED" : "DESTRUCTIVE";
    }

    if (SAFE_TOOLS.has(normalized)) {
      return "SAFE";
    }

    // Unknown tools default to DESTRUCTIVE (fail-safe)
    return "DESTRUCTIVE";
  }

  /**
   * Determine if a tool mutates files (used to decide when to run
   * scope enforcement and write to the trace ledger).
   */
  static isMutating(toolName: string): boolean {
    return (
      DESTRUCTIVE_TOOLS.has(toolName) || ELEVATED_TOOLS.has(toolName)
    );
  }

  /**
   * Extract the target file path from tool parameters (handles
   * different naming conventions across Roo Code / Cline).
   */
  static extractTargetPath(
    toolName: string,
    parameters: Record<string, unknown>
  ): string | null {
    // Common parameter names across Roo Code / Cline
    const candidates = ["path", "file_path", "filePath", "target", "filename"];
    for (const key of candidates) {
      if (typeof parameters[key] === "string") {
        return parameters[key] as string;
      }
    }
    return null;
  }

  /**
   * Extract new file content from write parameters.
   */
  static extractContent(
    toolName: string,
    parameters: Record<string, unknown>
  ): string | null {
    const candidates = ["content", "new_content", "newContent", "text", "code"];
    for (const key of candidates) {
      if (typeof parameters[key] === "string") {
        return parameters[key] as string;
      }
    }
    return null;
  }
}