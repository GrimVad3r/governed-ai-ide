# ARCHITECTURE_NOTES.md
## Phase 0: The Archaeological Dig — Roo Code Extension Map

---

## 1. Extension Host Structure (Roo Code)

After forking and running Roo Code, the key files to understand are:

```
roo-code/
├── src/
│   ├── extension.ts              ← VS Code activate() entry point
│   ├── core/
│   │   ├── Cline.ts              ← ★ MAIN AGENT CLASS — patch here
│   │   ├── prompts/
│   │   │   └── system.ts         ← ★ SYSTEM PROMPT BUILDER — patch here
│   │   └── tools/
│   │       ├── index.ts          ← Tool registry
│   │       └── *.ts              ← Individual tool handlers
│   ├── api/
│   │   └── providers/            ← LLM API adapters (Anthropic, OpenAI, etc.)
│   └── shared/
│       └── ExtensionMessage.ts   ← Webview ↔ Extension Host message types
└── webview-ui/
    └── src/
        └── App.tsx               ← Webview presentation layer (READ-ONLY)
```

---

## 2. Tool Execution Loop (The Nervous System)

### 2a. Where Tool Calls Originate
```
LLM Response
    │
    ▼
Cline.ts → parseAssistantMessage()
    │  Extracts <tool_call> blocks from streamed LLM output
    ▼
Cline.ts → executeTool(toolName, params)   ← ★ PRIMARY HOOK POINT
    │
    ├── [PreHook]  ← INJECT HERE (before line below)
    ▼
ToolHandlers/write_to_file.ts  (or read_file.ts, execute_command.ts, etc.)
    │
    ├── [PostHook] ← INJECT HERE (after tool returns)
    ▼
Tool result returned to LLM as next message
```

### 2b. Exact Function Signature to Patch (Roo Code ~v3.x)
```typescript
// In src/core/Cline.ts, approximately line 850-950:
private async executeTool(
  toolName: ToolName,
  toolInput: Record<string, unknown>
): Promise<ToolResponse>
```

### 2c. Patching Strategy
```typescript
// In our extension.ts, after Cline is imported:
import { Cline } from "./core/Cline";   // adjust path

const _originalExecuteTool = Cline.prototype["executeTool"];

Cline.prototype["executeTool"] = async function (toolName, toolInput) {
  const sessionId = this.taskId ?? this.conversationId ?? "default-session";

  // ── PRE HOOK ────────────────────────────────────────────
  const preResult = await hookEngine.preProcess({
    toolName,
    parameters: toolInput,
    sessionId,
  });

  if (!preResult.allowed) {
    // Return error as a tool result — LLM can self-correct
    return {
      type: "tool_result",
      content: JSON.stringify({ error: preResult.error }),
    };
  }

  if (preResult.injectedContext) {
    // Append context to the system context that flows into next LLM call
    this._intentContext = preResult.injectedContext;
  }

  // ── ORIGINAL EXECUTION ───────────────────────────────────
  const result = await _originalExecuteTool.call(this, toolName, toolInput);

  // ── POST HOOK ────────────────────────────────────────────
  await hookEngine.postProcess({
    toolName,
    parameters: toolInput,
    result,
    sessionId,
    mutationClass: (toolInput as Record<string, unknown>)["mutation_class"] as MutationClass,
  });

  return result;
};
```

---

## 3. System Prompt Location

```typescript
// In src/core/prompts/system.ts:
export async function SYSTEM_PROMPT(
  cwd: string,
  supportsComputerUse: boolean,
  ...
): Promise<string>
```

**Patch approach:**
```typescript
import { getGovernanceSystemPrompt } from "./prompts/system_prompt_injection";
import { SYSTEM_PROMPT as _ORIGINAL_SYSTEM_PROMPT } from "./core/prompts/system";

// Override:
async function SYSTEM_PROMPT(...args) {
  const base = await _ORIGINAL_SYSTEM_PROMPT(...args);
  const governance = getGovernanceSystemPrompt({ agentLabel: "Builder" });
  return governance + "\n\n" + base;
}
```

---

## 4. Tool Registry Location

```typescript
// In src/core/tools/index.ts or similar:
const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: "read_file", ... },
  { name: "write_to_file", ... },
  // ... etc
];
```

**Patch approach:**
```typescript
import { GOVERNANCE_TOOLS } from "./tools/select_active_intent";

// After the tool definitions array is built:
TOOL_DEFINITIONS.push(...GOVERNANCE_TOOLS);
```

---

## 5. WebView Boundary

The WebView communicates ONLY via `postMessage`. No business logic lives there.
The Hook Engine runs ONLY in the Extension Host (Node.js process).

```
WebView (browser context)
  └── postMessage("userInput", { text: "Refactor auth" })
        │
        ▼  [Extension Host message handler]
  Cline.ts → handleWebviewMessage()
        │
        ▼
  Cline.ts → startTask() → LLM call loop → executeTool() ← HOOK POINT
```

---

## 6. Key Files Modified (Summary)

| File | Modification |
|------|-------------|
| `src/extension.ts` | Initialize HookEngine, register commands, wire HITL fn |
| `src/core/Cline.ts` | Monkey-patch `executeTool()` with pre/post hooks |
| `src/core/prompts/system.ts` | Prepend governance system prompt |
| `src/core/tools/index.ts` | Add GOVERNANCE_TOOLS to registry |
| `src/hooks/` | New directory — the entire Hook Engine |
| `.orchestration/` | New directory — data layer |

---

## 7. Session Identity

Roo Code creates a new `Cline` instance per task (each user prompt).
We map `Cline.taskId` → our `sessionId` for state machine continuity.

If the same task continues across turns, the `taskId` is preserved — so
session state (active intent, file snapshots) persists across the entire task.

---

## 8. Privilege Boundary Summary

```
┌─────────────────────────────────────────────────────────┐
│  WebView (Presentation Layer)                            │
│  - User types prompts                                    │
│  - Sees agent responses                                  │
│  - NO access to file system                              │
│  - Communicates via postMessage ONLY                     │
├─────────────────────────────────────────────────────────┤
│  Extension Host (Logic Layer — our patch lives here)     │
│  - Runs Node.js                                          │
│  - Has full file system access                           │
│  - Manages API keys, MCP connections                     │
│  - ★ HookEngine runs here                               │
│    ├── PreHookProcessor (intent gate, scope check)       │
│    ├── PostHookProcessor (trace write, map update)       │
│    ├── StateMachine (session phase tracking)             │
│    ├── IntentManager (YAML CRUD)                         │
│    ├── ScopeEnforcer (.intentignore + glob check)        │
│    ├── ConcurrencyGuard (optimistic lock)                │
│    └── TraceLogger (append-only JSONL ledger)            │
└─────────────────────────────────────────────────────────┘
```