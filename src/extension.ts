// ============================================================
// extension.ts — VS Code Extension Entry Point
// ============================================================
// Purpose: Bootstrap the HookEngine within the VS Code Extension
// Host. This file wires the HookEngine into Roo Code / Cline's
// tool execution pipeline via monkey-patching the tool executor.
//
// INTEGRATION STEPS (after forking Roo Code):
//   1. Import this file in the main extension activate() function.
//   2. Pass the workspace root and orchestration config.
//   3. The hook engine intercepts tool calls automatically.
//
// NOTE: The exact patching target varies between Roo Code versions.
// See ARCHITECTURE_NOTES.md for the specific functions to patch.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";

import { HookEngine } from "./hooks/HookEngine";
import { HookEngineConfig, ActiveIntent, ActiveIntentsFile } from "./hooks/types";
import { GOVERNANCE_TOOLS } from "./tools/select_active_intent";
import { getGovernanceSystemPrompt } from "./prompts/system_prompt_injection";

// Status bar item for session monitoring
let statusBarItem: vscode.StatusBarItem;
let hookEngine: HookEngine;

// ── Extension Activation ─────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const orchestrationDir = path.join(workspaceRoot, ".orchestration");
  fs.mkdirSync(orchestrationDir, { recursive: true });

  const config: HookEngineConfig = {
    orchestrationDir,
    workspaceRoot,
    agentLabel: "Builder",
    modelIdentifier: "claude-sonnet-4-6",
    enableHITL: vscode.workspace
      .getConfiguration("governedAI")
      .get("enableHITL", true),
    enableScopeEnforcement: vscode.workspace
      .getConfiguration("governedAI")
      .get("enableScopeEnforcement", true),
    enableConcurrencyGuard: vscode.workspace
      .getConfiguration("governedAI")
      .get("enableConcurrencyGuard", true),
    enableTracing: vscode.workspace
      .getConfiguration("governedAI")
      .get("enableTracing", true),
  };

  // Initialize the hook engine with VS Code HITL function
  hookEngine = HookEngine.getInstance(config, async (message: string) => {
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      "✅ Approve",
      "❌ Reject"
    );
    return choice === "✅ Approve";
  });

  // ── Status Bar ───────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "governedAI.showStatus";
  statusBarItem.text = "$(shield) AI Governed";
  statusBarItem.tooltip = "Governed AI IDE — Click for session status";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── File Watcher for .orchestration/ ────────────────────
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, ".orchestration/**")
  );
  watcher.onDidChange(() => updateStatusBar());
  context.subscriptions.push(watcher);

  // ── Commands ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("governedAI.showStatus", showStatusPanel),
    vscode.commands.registerCommand(
      "governedAI.newSession",
      (agentLabel?: string) => {
        const session = hookEngine.createSession(agentLabel);
        vscode.window.showInformationMessage(
          `New ${agentLabel ?? "Builder"} session: ${session.sessionId.slice(0, 8)}...`
        );
        updateStatusBar();
        return session.sessionId;
      }
    ),
    vscode.commands.registerCommand("governedAI.listIntents", listIntentsQuickPick),
    vscode.commands.registerCommand("governedAI.addIntent", addIntentWizard),
    vscode.commands.registerCommand(
      "governedAI.resetSession",
      (sessionId?: string) => {
        if (sessionId) {
          hookEngine.resetSession(sessionId);
          vscode.window.showInformationMessage(`Session ${sessionId.slice(0, 8)} reset.`);
        }
      }
    ),
    vscode.commands.registerCommand("governedAI.openTraceLog", openTraceLog),
    vscode.commands.registerCommand(
      "governedAI.reloadIntentIgnore",
      () => {
        // Scope enforcer reloads on next call automatically
        vscode.window.showInformationMessage(".intentignore reloaded.");
      }
    )
  );

  // ── Initialize Orchestration Files ───────────────────────
  initializeOrchestrationFiles(workspaceRoot, orchestrationDir);

  vscode.window.showInformationMessage(
    "🛡️ Governed AI IDE activated. Intent tracking is live."
  );
}

// ── Hook Integration Point ────────────────────────────────────
//
// This is where you patch Roo Code / Cline's tool executor.
// The exact method name depends on the fork version.
// See ARCHITECTURE_NOTES.md Phase 0 for discovery steps.
//
// Example patch for Roo Code's executeTool:
//
//   const originalExecuteTool = ClineInstance.prototype.executeTool;
//   ClineInstance.prototype.executeTool = async function(toolName, params) {
//     const sessionId = this.taskId ?? this.conversationId ?? "default";
//     const preResult = await hookEngine.preProcess({ toolName, parameters: params, sessionId });
//
//     if (!preResult.allowed) {
//       return { type: "error", error: JSON.stringify(preResult.error) };
//     }
//     if (preResult.injectedContext) {
//       this.currentPromptContext = (this.currentPromptContext ?? "") + "\n" + preResult.injectedContext;
//     }
//
//     const result = await originalExecuteTool.call(this, toolName, params);
//
//     await hookEngine.postProcess({
//       toolName, parameters: params, result,
//       sessionId, mutationClass: params.mutation_class
//     });
//
//     return result;
//   };
//
//   // Add governance tools to the tool registry
//   ClineInstance.prototype.getAvailableTools = function() {
//     return [...originalGetAvailableTools.call(this), ...GOVERNANCE_TOOLS];
//   };
//
//   // Inject governance system prompt
//   ClineInstance.prototype.buildSystemPrompt = function() {
//     const base = originalBuildSystemPrompt.call(this);
//     return getGovernanceSystemPrompt({ agentLabel: this.agentLabel }) + "\n\n" + base;
//   };

// ── UI Helpers ────────────────────────────────────────────────

async function showStatusPanel(): Promise<void> {
  const status = hookEngine.getStatus() as Record<string, unknown>;
  const sessions = hookEngine.getAllSessions();

  const panel = vscode.window.createWebviewPanel(
    "governedAIStatus",
    "Governed AI — Session Status",
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  const rows = sessions
    .map(
      (s) => `
    <tr>
      <td>${s.agentLabel ?? "?"}</td>
      <td>${s.sessionId.slice(0, 8)}…</td>
      <td><span class="badge ${s.phase}">${s.phase}</span></td>
      <td>${s.activeIntentId ?? "—"}</td>
      <td>${new Date(s.lastActionAt).toLocaleTimeString()}</td>
    </tr>`
    )
    .join("");

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; border: 1px solid var(--vscode-panel-border); text-align: left; }
    th { background: var(--vscode-editor-lineHighlightBackground); }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; }
    .INTENT_LOADED { background: #1a7f37; color: white; }
    .AWAITING_INTENT { background: #bf8700; color: white; }
    .BLOCKED { background: #cf222e; color: white; }
    .stat { margin: 8px 0; }
  </style>
</head>
<body>
  <h2>🛡️ Governed AI — Session Monitor</h2>
  <div class="stat">Active Sessions: <strong>${sessions.length}</strong></div>
  <div class="stat">HITL: <strong>${(status.config as Record<string, unknown>)?.hitlEnabled ? "ON" : "OFF"}</strong></div>
  <div class="stat">Scope Enforcement: <strong>${(status.config as Record<string, unknown>)?.scopeEnforcementEnabled ? "ON" : "OFF"}</strong></div>
  <br/>
  <table>
    <thead>
      <tr><th>Agent</th><th>Session ID</th><th>Phase</th><th>Intent</th><th>Last Action</th></tr>
    </thead>
    <tbody>${rows || "<tr><td colspan='5'>No active sessions</td></tr>"}</tbody>
  </table>
</body>
</html>`;
}

async function listIntentsQuickPick(): Promise<void> {
  const manager = hookEngine.getIntentManager();
  const { active_intents } = manager.loadAll();
  const items = active_intents.map((i) => ({
    label: `$(circle-filled) ${i.id}`,
    description: i.name,
    detail: `Status: ${i.status} | Scope: ${i.owned_scope.join(", ")}`,
    id: i.id,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select an intent to inspect",
  });
  if (pick) {
    const ctx = manager.buildContextBlock((pick as typeof pick & { id: string }).id);
    const doc = await vscode.workspace.openTextDocument({
      content: ctx,
      language: "xml",
    });
    vscode.window.showTextDocument(doc);
  }
}

async function addIntentWizard(): Promise<void> {
  const id = await vscode.window.showInputBox({
    prompt: "Intent ID (e.g. INT-002)",
    placeHolder: "INT-002",
  });
  if (!id) return;

  const name = await vscode.window.showInputBox({
    prompt: "Intent Name",
    placeHolder: "Build Weather API",
  });
  if (!name) return;

  const scope = await vscode.window.showInputBox({
    prompt: "Owned scope globs (comma-separated)",
    placeHolder: "src/weather/**,src/types/weather.ts",
  });

  const constraints = await vscode.window.showInputBox({
    prompt: "Constraints (comma-separated)",
    placeHolder: "Must not use external paid APIs",
  });

  const criteria = await vscode.window.showInputBox({
    prompt: "Acceptance criteria (comma-separated)",
    placeHolder: "Tests in tests/weather/ pass",
  });

  const intent: ActiveIntent = {
    id,
    name: name ?? "",
    status: "PENDING",
    owned_scope: (scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    constraints: (constraints ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    acceptance_criteria: (criteria ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };

  try {
    hookEngine.getIntentManager().addIntent(intent);
    vscode.window.showInformationMessage(`✅ Intent ${id} created.`);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to create intent: ${(err as Error).message}`);
  }
}

async function openTraceLog(): Promise<void> {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const tracePath = path.join(workspaceRoot, ".orchestration", "agent_trace.jsonl");
  if (fs.existsSync(tracePath)) {
    const uri = vscode.Uri.file(tracePath);
    vscode.window.showTextDocument(uri);
  } else {
    vscode.window.showWarningMessage("No trace log found. Run an agent first.");
  }
}

function updateStatusBar(): void {
  const sessions = hookEngine.getAllSessions();
  const blocked = sessions.filter((s) => s.phase === "BLOCKED").length;
  const active = sessions.filter((s) => s.phase === "INTENT_LOADED").length;

  if (blocked > 0) {
    statusBarItem.text = `$(shield) AI: ${blocked} BLOCKED`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (active > 0) {
    statusBarItem.text = `$(shield) AI: ${active} Active`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(shield) AI Governed";
    statusBarItem.backgroundColor = undefined;
  }
}

// ── Initialization ────────────────────────────────────────────

function initializeOrchestrationFiles(
  workspaceRoot: string,
  orchestrationDir: string
): void {
  // Create active_intents.yaml if not exists
  const intentsPath = path.join(orchestrationDir, "active_intents.yaml");
  if (!fs.existsSync(intentsPath)) {
    const template: ActiveIntentsFile = {
      active_intents: [
        {
          id: "INT-001",
          name: "Example Intent — Replace Me",
          status: "PENDING",
          owned_scope: ["src/**"],
          constraints: ["Must maintain backward compatibility"],
          acceptance_criteria: ["All existing tests pass"],
        },
      ],
    };
    fs.writeFileSync(intentsPath, yaml.dump(template, { indent: 2 }), "utf8");
  }

  // Create .intentignore if not exists
  const ignorePath = path.join(orchestrationDir, ".intentignore");
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(
      ignorePath,
      [
        "# Files that NO agent may ever modify",
        ".orchestration/**",
        "node_modules/**",
        ".git/**",
        "*.lock",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  // Create CLAUDE.md (shared brain) if not exists
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      [
        "# CLAUDE.md — Shared Agent Brain",
        "",
        "This file is a persistent knowledge base shared across ALL parallel agent sessions.",
        "It is automatically updated when agents encounter failures or make architectural decisions.",
        "READ THIS at the start of every session to inherit institutional knowledge.",
        "",
        "## Project Rules",
        "",
        "- Always select an active intent before writing code.",
        "- Never modify files in .orchestration/ directly.",
        "- Run lint and tests after every file write.",
        "",
        "## Lessons Learned",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  // Create intent_map.md if not exists
  const intentMapPath = path.join(orchestrationDir, "intent_map.md");
  if (!fs.existsSync(intentMapPath)) {
    fs.writeFileSync(
      intentMapPath,
      "# Intent Map\n\nMaps business intents to physical files and AST nodes.\nAuto-updated by the Hook Engine.\n",
      "utf8"
    );
  }
}

export function deactivate(): void {
  HookEngine.reset();
  statusBarItem?.dispose();
}