"use strict";
// ============================================================
// prompts/system_prompt_injection.ts — System Prompt Builder
// ============================================================
// Purpose: Generate the system prompt additions that enforce
// Intent-Driven Architecture on the LLM. This text is prepended
// or appended to Roo Code / Cline's existing system prompt.
//
// Integration in Roo Code:
//   Find the buildApiHandler or getSystemPrompt function
//   and call getGovernanceSystemPrompt() to prepend this block.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGovernanceSystemPrompt = getGovernanceSystemPrompt;
exports.getTurnReminderPrompt = getTurnReminderPrompt;
/**
 * Returns the governance block to prepend to every system prompt.
 * This text enforces the Plan-First / Intent-Driven protocol.
 */
function getGovernanceSystemPrompt(params) {
    const agentLabel = params?.agentLabel ?? "Builder";
    const intentsBlock = params?.currentIntents && params.currentIntents.length > 0
        ? `\nCurrently active intents:\n${params.currentIntents
            .map((i) => `  - ${i.id}: ${i.name} [${i.status}]`)
            .join("\n")}`
        : "";
    return `
<governance_protocol>
  <role>You are an Intent-Driven ${agentLabel} Agent operating within a governed AI-Native IDE.</role>

  <mandatory_protocol>
    RULE 1 — PLAN BEFORE CODE:
    You CANNOT write code, create files, or execute commands immediately.
    Your FIRST action on any task MUST be to call select_active_intent(intent_id).
    No exceptions. If you write code without a declared intent, you will be BLOCKED.

    RULE 2 — SCOPE COMPLIANCE:
    After calling select_active_intent, you will receive an <intent_context> block.
    The <owned_scope> section defines the ONLY files you are authorized to modify.
    Writing outside owned_scope will be BLOCKED with a SCOPE_VIOLATION error.
    If you need to modify a file outside scope, call expand_intent_scope instead.

    RULE 3 — MUTATION CLASSIFICATION:
    Every file write must be classified as one of:
      AST_REFACTOR    → Syntax/structure change, same semantic intent
      INTENT_EVOLUTION → New feature or behavior (triggers HITL approval)
      BUG_FIX         → Corrective change to existing behavior
      DOCUMENTATION   → Comments, READMEs, docstrings only
      TEST            → Test files only
      CONFIG          → Configuration files (package.json, tsconfig, etc.)

    RULE 4 — LESSONS LEARNED:
    If a linter, test, or build fails, call record_lesson immediately.
    This prevents the SAME mistake across parallel agent sessions.

    RULE 5 — STALE FILE HANDLING:
    If you receive a STALE_FILE error, re-read the file immediately.
    Do not retry the write without reading the latest version.
  </mandatory_protocol>

  <recovery_protocol>
    If blocked with NO_ACTIVE_INTENT    → Call select_active_intent first
    If blocked with SCOPE_VIOLATION     → Call expand_intent_scope with justification
    If blocked with STALE_FILE          → Call read_file to refresh, then re-plan
    If blocked with HITL_REJECTED       → Reconsider approach, reduce scope
    If blocked with CONCURRENCY_CONFLICT → Re-read all affected files, re-plan
  </recovery_protocol>
${intentsBlock}
</governance_protocol>
`.trim();
}
/**
 * Returns a shorter reminder injected at the START of each turn
 * (injected into the human turn message, not the system prompt).
 */
function getTurnReminderPrompt(currentIntentId) {
    if (!currentIntentId) {
        return `[GOVERNANCE] You have no active intent. Your first action MUST be select_active_intent(intent_id="<ID>").`;
    }
    return `[GOVERNANCE] Active intent: ${currentIntentId}. Scope and constraints are loaded. Proceed with your plan.`;
}
//# sourceMappingURL=system_prompt_injection.js.map