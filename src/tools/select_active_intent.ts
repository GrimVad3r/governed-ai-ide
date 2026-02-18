// ============================================================
// tools/select_active_intent.ts — Tool Definition
// ============================================================
// Purpose: Expose select_active_intent as a first-class tool
// that the LLM can call. This is the mandatory "Handshake" tool —
// the agent must call this before ANY mutating action.
//
// In Roo Code / Cline, tools are defined as JSON schemas.
// This file exports the schema and the handler function.

import { IntentManager } from "../hooks/IntentManager";
import { TraceLogger } from "../hooks/TraceLogger";

// ── Tool Schema (inject into system prompt / tool registry) ──

export const SELECT_ACTIVE_INTENT_SCHEMA = {
  name: "select_active_intent",
  description: `
    MANDATORY HANDSHAKE TOOL. You MUST call this before writing any code or executing
    any mutating command.
    
    This tool loads the business intent context for the specified intent ID and injects
    it into your context window. After calling this tool, you will receive:
    - The exact file scope you are authorized to modify
    - Architectural constraints you must respect
    - Acceptance criteria that define "done"
    - Related requirement IDs to link in the trace
    
    Call this FIRST. Without a valid intent, all write operations will be blocked.
  `.trim(),
  input_schema: {
    type: "object",
    properties: {
      intent_id: {
        type: "string",
        description:
          "The intent ID from active_intents.yaml, e.g. 'INT-001'. " +
          "Read active_intents.yaml first if you are unsure which ID to use.",
      },
    },
    required: ["intent_id"],
  },
};

export const EXPAND_INTENT_SCOPE_SCHEMA = {
  name: "expand_intent_scope",
  description: `
    Request scope expansion for the active intent.
    Use when you discover that a necessary file is outside the current owned_scope.
    This triggers a Human-in-the-Loop approval dialog. The human must approve before
    the scope expansion takes effect.
  `.trim(),
  input_schema: {
    type: "object",
    properties: {
      intent_id: {
        type: "string",
        description: "The intent ID to expand scope for.",
      },
      new_glob: {
        type: "string",
        description:
          "The glob pattern to add to owned_scope, e.g. 'src/shared/**'",
      },
      justification: {
        type: "string",
        description:
          "Explain WHY this file is necessary for the intent. Be specific.",
      },
    },
    required: ["intent_id", "new_glob", "justification"],
  },
};

export const MARK_INTENT_COMPLETE_SCHEMA = {
  name: "mark_intent_complete",
  description: `
    Mark an intent as COMPLETE once all acceptance criteria have been met.
    This triggers a final audit of the agent_trace.jsonl for the intent
    and appends a completion summary to intent_map.md.
    Only call this when ALL acceptance criteria pass.
  `.trim(),
  input_schema: {
    type: "object",
    properties: {
      intent_id: {
        type: "string",
        description: "The intent ID to mark as complete.",
      },
      completion_notes: {
        type: "string",
        description:
          "Brief summary of what was done and any deviations from the original plan.",
      },
    },
    required: ["intent_id", "completion_notes"],
  },
};

export const RECORD_LESSON_SCHEMA = {
  name: "record_lesson",
  description: `
    Append a lesson learned to CLAUDE.md. Call this when:
    - A linter or test fails unexpectedly
    - An architectural decision needed correction
    - A constraint was discovered that wasn't in the intent spec
    This creates a persistent shared-brain entry for ALL future agent sessions.
  `.trim(),
  input_schema: {
    type: "object",
    properties: {
      intent_id: {
        type: "string",
        description: "The current active intent ID.",
      },
      lesson: {
        type: "string",
        description:
          "The lesson learned. Be specific and actionable for future agents.",
      },
      failure_type: {
        type: "string",
        enum: ["lint", "test", "build", "scope_violation", "other"],
        description: "The type of failure that triggered this lesson.",
      },
    },
    required: ["intent_id", "lesson", "failure_type"],
  },
};

// ── All Tool Schemas (inject into tool registry) ──────────────

export const GOVERNANCE_TOOLS = [
  SELECT_ACTIVE_INTENT_SCHEMA,
  EXPAND_INTENT_SCOPE_SCHEMA,
  MARK_INTENT_COMPLETE_SCHEMA,
  RECORD_LESSON_SCHEMA,
];