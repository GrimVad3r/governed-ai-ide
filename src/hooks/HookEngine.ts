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

import { PreHookProcessor, HITLApprovalFn } from "./PreHookProcessor";
import { PostHookProcessor, PostHookContext } from "./PostHookProcessor";
import { IntentManager } from "./IntentManager";
import { StateMachine } from "./StateMachine";
import { ScopeEnforcer } from "./ScopeEnforcer";
import { TraceLogger } from "./TraceLogger";
import {
  HookEngineConfig,
  ToolCallRequest,
  ToolCallResult,
  SessionState,
} from "./types";

export class HookEngine {
  private static instance: HookEngine | null = null;

  private config: HookEngineConfig;
  private intentManager: IntentManager;
  private stateMachine: StateMachine;
  private scopeEnforcer: ScopeEnforcer;
  private traceLogger: TraceLogger;
  private preHook: PreHookProcessor;
  private postHook: PostHookProcessor;

  constructor(config: HookEngineConfig, requestHITLApproval: HITLApprovalFn) {
    this.config = config;

    // Instantiate subsystems
    this.intentManager = new IntentManager(config);
    this.stateMachine = new StateMachine();
    this.scopeEnforcer = new ScopeEnforcer(config, this.intentManager);
    this.traceLogger = new TraceLogger(config);

    // Wire pre/post hooks
    this.preHook = new PreHookProcessor(
      config,
      this.intentManager,
      this.stateMachine,
      this.scopeEnforcer,
      this.traceLogger,
      requestHITLApproval
    );

    this.postHook = new PostHookProcessor(
      config,
      this.traceLogger,
      this.intentManager,
      this.stateMachine
    );
  }

  // ── Singleton ─────────────────────────────────────────────

  static getInstance(
    config?: HookEngineConfig,
    requestHITLApproval?: HITLApprovalFn
  ): HookEngine {
    if (!HookEngine.instance) {
      if (!config || !requestHITLApproval) {
        throw new Error(
          "HookEngine must be initialized with config and HITL function on first call."
        );
      }
      HookEngine.instance = new HookEngine(config, requestHITLApproval);
    }
    return HookEngine.instance;
  }

  static reset(): void {
    HookEngine.instance = null;
  }

  // ── Public API ────────────────────────────────────────────

  /** Call BEFORE executing any tool. */
  async preProcess(request: ToolCallRequest): Promise<ToolCallResult> {
    try {
      return await this.preHook.process(request);
    } catch (err) {
      console.error("[HookEngine] PreHook error:", err);
      // Fail-safe: allow execution but log the error
      return { allowed: true };
    }
  }

  /** Call AFTER a tool has executed successfully. */
  async postProcess(ctx: PostHookContext): Promise<void> {
    try {
      await this.postHook.process(ctx);
    } catch (err) {
      console.error("[HookEngine] PostHook error:", err);
      // Non-blocking — post-hook failures must not crash the agent
    }
  }

  // ── Session Management ────────────────────────────────────

  createSession(agentLabel?: string): SessionState {
    return this.stateMachine.createSession(agentLabel);
  }

  getSession(sessionId: string): SessionState | null {
    return this.stateMachine.getSession(sessionId);
  }

  getAllSessions(): SessionState[] {
    return this.stateMachine.getAllSessions();
  }

  resetSession(sessionId: string): void {
    this.stateMachine.reset(sessionId);
  }

  // ── Intent API (convenience passthrough) ─────────────────

  getIntentManager(): IntentManager {
    return this.intentManager;
  }

  getTraceLogger(): TraceLogger {
    return this.traceLogger;
  }

  // ── Diagnostics ───────────────────────────────────────────

  getStatus(): object {
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