// ============================================================
// StateMachine.ts — Two-Stage Session State Machine
// ============================================================
// Purpose: Enforce the mandatory "Plan-First" protocol.
// An agent session CANNOT write code until it has declared
// a valid intent via select_active_intent(). This prevents
// "Vibe Coding" at the architectural level.
//
// State Diagram:
//   [AWAITING_INTENT] --select_active_intent()--> [INTENT_LOADED]
//   [INTENT_LOADED]   --scope violation---------> [BLOCKED]
//   [BLOCKED]         --new intent or fix-------> [INTENT_LOADED]

import { v4 as uuidv4 } from "uuid";
import { SessionState, SessionPhase, ActiveIntent } from "./types";

export class StateMachine {
  private sessions: Map<string, SessionState> = new Map();

  // ── Session Lifecycle ─────────────────────────────────────

  /** Create a new session (called when a chat panel opens) */
  createSession(
    agentLabel?: string
  ): SessionState {
    const sessionId = uuidv4();
    const state: SessionState = {
      sessionId,
      phase: "AWAITING_INTENT",
      activeIntentId: null,
      activeIntent: null,
      fileHashSnapshot: {},
      startedAt: new Date().toISOString(),
      lastActionAt: new Date().toISOString(),
      agentLabel: agentLabel ?? "Builder",
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  /** Retrieve existing session or create a new one */
  getOrCreate(sessionId: string, agentLabel?: string): SessionState {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    const state = this.createSession(agentLabel);
    // Override generated ID with the provided one for determinism
    state.sessionId = sessionId;
    this.sessions.set(sessionId, state);
    return state;
  }

  getSession(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  // ── Transitions ───────────────────────────────────────────

  /**
   * Transition: AWAITING_INTENT → INTENT_LOADED
   * Called by the Pre-Hook when select_active_intent succeeds.
   */
  transitionToLoaded(sessionId: string, intent: ActiveIntent): SessionState {
    const state = this.getOrCreate(sessionId);
    state.phase = "INTENT_LOADED";
    state.activeIntentId = intent.id;
    state.activeIntent = intent;
    state.lastActionAt = new Date().toISOString();
    this.sessions.set(sessionId, state);
    return state;
  }

  /**
   * Transition: any → BLOCKED
   * Called by Pre-Hook on scope violation or security breach.
   */
  transitionToBlocked(sessionId: string): SessionState {
    const state = this.getOrCreate(sessionId);
    state.phase = "BLOCKED";
    state.lastActionAt = new Date().toISOString();
    this.sessions.set(sessionId, state);
    return state;
  }

  /**
   * Recover from BLOCKED by loading a new valid intent.
   */
  recover(sessionId: string, intent: ActiveIntent): SessionState {
    return this.transitionToLoaded(sessionId, intent);
  }

  /**
   * Reset session (e.g. user starts a new task)
   */
  reset(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.phase = "AWAITING_INTENT";
    state.activeIntentId = null;
    state.activeIntent = null;
    state.fileHashSnapshot = {};
    state.lastActionAt = new Date().toISOString();
    this.sessions.set(sessionId, state);
  }

  // ── File Hash Snapshot (for Optimistic Locking) ──────────

  /** Record the hash of a file at read-time */
  snapshotFile(sessionId: string, filePath: string, hash: string): void {
    const state = this.getOrCreate(sessionId);
    state.fileHashSnapshot[filePath] = hash;
    this.sessions.set(sessionId, state);
  }

  /** Get the hash that was recorded at read-time */
  getSnapshot(sessionId: string, filePath: string): string | null {
    const state = this.getSession(sessionId);
    return state?.fileHashSnapshot[filePath] ?? null;
  }

  // ── Guards ────────────────────────────────────────────────

  isReadyToWrite(sessionId: string): boolean {
    const state = this.getSession(sessionId);
    return state?.phase === "INTENT_LOADED";
  }

  isBlocked(sessionId: string): boolean {
    const state = this.getSession(sessionId);
    return state?.phase === "BLOCKED";
  }

  getCurrentIntent(sessionId: string): ActiveIntent | null {
    return this.getSession(sessionId)?.activeIntent ?? null;
  }

  // ── Diagnostics ───────────────────────────────────────────

  /** Summary of all active sessions — useful for parallel agent monitoring */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}