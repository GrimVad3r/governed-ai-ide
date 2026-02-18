// ============================================================
// types.ts — Central Type Definitions for the Hook Engine
// ============================================================

// ── Intent Types ─────────────────────────────────────────────

export type IntentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "COMPLETE"
  | "ABANDONED";

export type MutationClass =
  | "AST_REFACTOR"       // Syntax change, same semantic intent
  | "INTENT_EVOLUTION"   // New feature / scope expansion
  | "BUG_FIX"            // Corrective change
  | "DOCUMENTATION"      // Docs-only change
  | "TEST"               // Test file change
  | "CONFIG"             // Config / infra change
  | "UNKNOWN";

export interface IntentConstraint {
  description: string;
}

export interface AcceptanceCriterion {
  description: string;
}

export interface ActiveIntent {
  id: string;                         // e.g. "INT-001"
  name: string;
  status: IntentStatus;
  owned_scope: string[];              // glob patterns
  constraints: string[];
  acceptance_criteria: string[];
  created_at?: string;
  updated_at?: string;
  related_requirements?: string[];    // REQ-XXX links
}

export interface ActiveIntentsFile {
  active_intents: ActiveIntent[];
}

// ── Session State (Two-Stage State Machine) ─────────────────

export type SessionPhase =
  | "AWAITING_INTENT"     // Agent hasn't declared intent yet
  | "INTENT_LOADED"       // Intent context injected, may write code
  | "BLOCKED";            // Scope/security violation

export interface SessionState {
  sessionId: string;
  phase: SessionPhase;
  activeIntentId: string | null;
  activeIntent: ActiveIntent | null;
  fileHashSnapshot: Record<string, string>; // path → sha256 at read-time
  startedAt: string;
  lastActionAt: string;
  agentLabel?: "Architect" | "Builder" | "Tester" | string;
}

// ── Trace / Ledger Types ─────────────────────────────────────

export interface Contributor {
  entity_type: "AI" | "HUMAN";
  model_identifier?: string;
  user_id?: string;
}

export interface CodeRange {
  start_line: number;
  end_line: number;
  content_hash: string;           // sha256 of the code block
}

export interface RelatedRef {
  type: "specification" | "intent" | "requirement" | "issue";
  value: string;
}

export interface Conversation {
  url: string;                    // session log id
  contributor: Contributor;
  ranges: CodeRange[];
  related: RelatedRef[];
}

export interface TracedFile {
  relative_path: string;
  mutation_class: MutationClass;
  conversations: Conversation[];
}

export interface AgentTraceEntry {
  id: string;                     // uuid-v4
  timestamp: string;              // ISO 8601
  intent_id: string;
  vcs: { revision_id: string };
  files: TracedFile[];
}

// ── Tool Call Types ──────────────────────────────────────────

export type CommandRisk = "SAFE" | "DESTRUCTIVE" | "ELEVATED";

export interface ToolCallRequest {
  toolName: string;
  parameters: Record<string, unknown>;
  sessionId: string;
  conversationId?: string;
}

export interface ToolCallResult {
  allowed: boolean;
  modifiedParameters?: Record<string, unknown>;
  injectedContext?: string;       // XML block injected into prompt
  error?: HookError;
  requiresHITL?: boolean;
}

export interface HookError {
  code: HookErrorCode;
  message: string;
  recoveryHint: string;           // Sent to LLM so it can self-correct
}

export type HookErrorCode =
  | "NO_ACTIVE_INTENT"
  | "SCOPE_VIOLATION"
  | "STALE_FILE"
  | "HITL_REJECTED"
  | "INVALID_INTENT_ID"
  | "CONCURRENCY_CONFLICT"
  | "INTENTIGNORE_MATCH";

// ── Intent Map Types ─────────────────────────────────────────

export interface IntentMapEntry {
  intentId: string;
  intentName: string;
  files: string[];
  astNodes?: ASTNodeRef[];
  lastUpdated: string;
}

export interface ASTNodeRef {
  file: string;
  nodeType: string;               // "FunctionDeclaration", "ClassDeclaration" etc.
  name: string;
  start_line: number;
  end_line: number;
}

// ── Hook Engine Config ────────────────────────────────────────

export interface HookEngineConfig {
  orchestrationDir: string;       // absolute path to .orchestration/
  workspaceRoot: string;
  agentLabel?: string;
  modelIdentifier?: string;
  enableHITL: boolean;
  enableScopeEnforcement: boolean;
  enableConcurrencyGuard: boolean;
  enableTracing: boolean;
}