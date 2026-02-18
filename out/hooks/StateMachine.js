"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateMachine = void 0;
const uuid_1 = require("uuid");
class StateMachine {
    constructor() {
        this.sessions = new Map();
    }
    // ── Session Lifecycle ─────────────────────────────────────
    /** Create a new session (called when a chat panel opens) */
    createSession(agentLabel) {
        const sessionId = (0, uuid_1.v4)();
        const state = {
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
    getOrCreate(sessionId, agentLabel) {
        if (this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId);
        }
        const state = this.createSession(agentLabel);
        // Override generated ID with the provided one for determinism
        state.sessionId = sessionId;
        this.sessions.set(sessionId, state);
        return state;
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    // ── Transitions ───────────────────────────────────────────
    /**
     * Transition: AWAITING_INTENT → INTENT_LOADED
     * Called by the Pre-Hook when select_active_intent succeeds.
     */
    transitionToLoaded(sessionId, intent) {
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
    transitionToBlocked(sessionId) {
        const state = this.getOrCreate(sessionId);
        state.phase = "BLOCKED";
        state.lastActionAt = new Date().toISOString();
        this.sessions.set(sessionId, state);
        return state;
    }
    /**
     * Recover from BLOCKED by loading a new valid intent.
     */
    recover(sessionId, intent) {
        return this.transitionToLoaded(sessionId, intent);
    }
    /**
     * Reset session (e.g. user starts a new task)
     */
    reset(sessionId) {
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
    snapshotFile(sessionId, filePath, hash) {
        const state = this.getOrCreate(sessionId);
        state.fileHashSnapshot[filePath] = hash;
        this.sessions.set(sessionId, state);
    }
    /** Get the hash that was recorded at read-time */
    getSnapshot(sessionId, filePath) {
        const state = this.getSession(sessionId);
        return state?.fileHashSnapshot[filePath] ?? null;
    }
    // ── Guards ────────────────────────────────────────────────
    isReadyToWrite(sessionId) {
        const state = this.getSession(sessionId);
        return state?.phase === "INTENT_LOADED";
    }
    isBlocked(sessionId) {
        const state = this.getSession(sessionId);
        return state?.phase === "BLOCKED";
    }
    getCurrentIntent(sessionId) {
        return this.getSession(sessionId)?.activeIntent ?? null;
    }
    // ── Diagnostics ───────────────────────────────────────────
    /** Summary of all active sessions — useful for parallel agent monitoring */
    getAllSessions() {
        return Array.from(this.sessions.values());
    }
    getSessionCount() {
        return this.sessions.size;
    }
}
exports.StateMachine = StateMachine;
//# sourceMappingURL=StateMachine.js.map