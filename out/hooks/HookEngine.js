"use strict";
// ============================================================
// HookEngine.ts — Central Middleware Orchestrator
// ============================================================
// Purpose: The single integration point for the fork of Roo Code
// / Cline. ALL tool execution requests flow through this class.
// It wires together the Pre-Hook and Post-Hook processors, manages
// the global state machine, and exposes a clean API for integration
// into the extension host's tool execution loop.
//
// Integration Contract:
//   In Roo Code (src/core/Cline.ts or equivalent):
//
//   const hookEngine = HookEngine.getInstance(config);
//
//   // Before tool execution:
//   const preResult = await hookEngine.preProcess({ toolName, parameters, sessionId });
//   if (!preResult.allowed) {
//     return this.sendToolError(preResult.error!);
//   }
//   if (preResult.injectedContext) {
//     this.injectContextIntoPrompt(preResult.injectedContext);
//   }
//
//   // Execute tool normally...
//   const toolResult = await this.executeTool(toolName, parameters);
//
//   // After tool execution:
//   await hookEngine.postProcess({ toolName, parameters, result: toolResult, sessionId });
Object.defineProperty(exports, "__esModule", { value: true });
exports.HookEngine = void 0;
const PreHookProcessor_1 = require("./PreHookProcessor");
const PostHookProcessor_1 = require("./PostHookProcessor");
const IntentManager_1 = require("./IntentManager");
const StateMachine_1 = require("./StateMachine");
const ScopeEnforcer_1 = require("./ScopeEnforcer");
const TraceLogger_1 = require("./TraceLogger");
class HookEngine {
    constructor(config, requestHITLApproval) {
        this.config = config;
        // Instantiate subsystems
        this.intentManager = new IntentManager_1.IntentManager(config);
        this.stateMachine = new StateMachine_1.StateMachine();
        this.scopeEnforcer = new ScopeEnforcer_1.ScopeEnforcer(config, this.intentManager);
        this.traceLogger = new TraceLogger_1.TraceLogger(config);
        // Wire pre/post hooks
        this.preHook = new PreHookProcessor_1.PreHookProcessor(config, this.intentManager, this.stateMachine, this.scopeEnforcer, this.traceLogger, requestHITLApproval);
        this.postHook = new PostHookProcessor_1.PostHookProcessor(config, this.traceLogger, this.intentManager, this.stateMachine);
    }
    // ── Singleton ─────────────────────────────────────────────
    static getInstance(config, requestHITLApproval) {
        if (!HookEngine.instance) {
            if (!config || !requestHITLApproval) {
                throw new Error("HookEngine must be initialized with config and HITL function on first call.");
            }
            HookEngine.instance = new HookEngine(config, requestHITLApproval);
        }
        return HookEngine.instance;
    }
    static reset() {
        HookEngine.instance = null;
    }
    // ── Public API ────────────────────────────────────────────
    /** Call BEFORE executing any tool. */
    async preProcess(request) {
        try {
            return await this.preHook.process(request);
        }
        catch (err) {
            console.error("[HookEngine] PreHook error:", err);
            // Fail-safe: allow execution but log the error
            return { allowed: true };
        }
    }
    /** Call AFTER a tool has executed successfully. */
    async postProcess(ctx) {
        try {
            await this.postHook.process(ctx);
        }
        catch (err) {
            console.error("[HookEngine] PostHook error:", err);
            // Non-blocking — post-hook failures must not crash the agent
        }
    }
    // ── Session Management ────────────────────────────────────
    createSession(agentLabel) {
        return this.stateMachine.createSession(agentLabel);
    }
    getSession(sessionId) {
        return this.stateMachine.getSession(sessionId);
    }
    getAllSessions() {
        return this.stateMachine.getAllSessions();
    }
    resetSession(sessionId) {
        this.stateMachine.reset(sessionId);
    }
    // ── Intent API (convenience passthrough) ─────────────────
    getIntentManager() {
        return this.intentManager;
    }
    getTraceLogger() {
        return this.traceLogger;
    }
    // ── Diagnostics ───────────────────────────────────────────
    getStatus() {
        return {
            sessions: this.stateMachine.getSessionCount(),
            activeIntents: this.intentManager.getByStatus("IN_PROGRESS").length,
            config: {
                hitlEnabled: this.config.enableHITL,
                scopeEnforcementEnabled: this.config.enableScopeEnforcement,
                concurrencyGuardEnabled: this.config.enableConcurrencyGuard,
                tracingEnabled: this.config.enableTracing,
            },
        };
    }
}
exports.HookEngine = HookEngine;
HookEngine.instance = null;
//# sourceMappingURL=HookEngine.js.map