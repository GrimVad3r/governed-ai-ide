# governed-ai-ide
TRP1 Challenge Week 1
# Governed AI IDE
### Intent-Code Traceability Layer for AI Coding Agents

A fork of **Roo Code** instrumented with a deterministic Hook Engine that enforces:
- **Intent Declaration** before any file mutation
- **Scope Enforcement** via glob-based intent ownership
- **Cryptographic Traceability** linking code → intent → business requirement
- **Optimistic Locking** for parallel agent safety
- **Human-in-the-Loop (HITL)** gates for elevated/destructive actions

---

## Quick Start

```bash
# 1. Clone this repo (after forking Roo Code)
git clone <your-fork>
cd governed-ai-ide

# 2. Install dependencies
npm install

# 3. Compile
npm run compile

# 4. Open in VS Code Extension Development Host
F5  (or Run > Start Debugging)
```

---

## Folder Structure

```
governed-ai-ide/
├── src/
│   ├── hooks/                    ← ★ The Hook Engine
│   │   ├── HookEngine.ts         ← Central orchestrator (singleton)
│   │   ├── PreHookProcessor.ts   ← Left gate: intent/scope/lock checks
│   │   ├── PostHookProcessor.ts  ← Right gate: trace write, map update
│   │   ├── IntentManager.ts      ← active_intents.yaml CRUD + context builder
│   │   ├── StateMachine.ts       ← Two-stage session phase machine
│   │   ├── ScopeEnforcer.ts      ← Glob-based scope + .intentignore
│   │   ├── ConcurrencyGuard.ts   ← Optimistic locking (hash comparison)
│   │   ├── TraceLogger.ts        ← Append-only JSONL ledger writer
│   │   ├── CommandClassifier.ts  ← SAFE / DESTRUCTIVE / ELEVATED routing
│   │   ├── ContentHasher.ts      ← SHA-256 for spatial independence
│   │   ├── types.ts              ← All TypeScript interfaces
│   │   └── index.ts              ← Barrel export
│   │
│   ├── tools/
│   │   └── select_active_intent.ts   ← Tool schemas for LLM registry
│   │
│   ├── prompts/
│   │   └── system_prompt_injection.ts ← Governance system prompt
│   │
│   └── extension.ts              ← VS Code activate() + integration points
│
├── .orchestration/               ← Machine-managed data layer
│   ├── active_intents.yaml       ← Intent specification (edit manually)
│   ├── agent_trace.jsonl         ← Append-only trace ledger (auto)
│   ├── intent_map.md             ← Spatial file→intent map (auto)
│   └── .intentignore             ← Globally protected file patterns
│
├── tests/
│   └── HookEngine.test.ts        ← Full integration test suite
│
├── CLAUDE.md                     ← Shared agent brain (auto-updated)
├── ARCHITECTURE_NOTES.md         ← Phase 0 archaeological dig notes
├── package.json
└── tsconfig.json
```

---

## The Two-Stage State Machine

Every agent session goes through exactly two stages before it can write code:

```
User Prompt
     │
     ▼
[AWAITING_INTENT] ──── Agent calls select_active_intent("INT-001") ───►
                                                                        │
                   ◄── Pre-Hook loads intent context, injects XML ◄────┘
                   │
                   ▼
            [INTENT_LOADED] ──── Agent calls write_to_file ────────────►
                                                                        │
                              ◄── Pre-Hook validates scope + lock ◄────┘
                              ◄── Post-Hook writes trace entry ◄────────┘
```

If the agent tries to skip Step 1, it receives:
```json
{
  "error": {
    "code": "NO_ACTIVE_INTENT",
    "message": "No active intent declared. Cannot execute mutating actions.",
    "recoveryHint": "You MUST call select_active_intent(intent_id) before ..."
  }
}
```

---

## Key Concepts

### Spatial Independence (Content Hashing)
Every code block is hashed by **content**, not line number.
If surrounding code shifts, the hash remains valid — enabling precise attribution
even after refactors.

### .intentignore
Like `.gitignore` but for agents. Files matching patterns in `.orchestration/.intentignore`
are blocked from modification by **any** intent — protecting infrastructure, secrets, and
dependency files from AI mutation.

### Optimistic Locking
No file locks. Instead:
1. File hash captured at **read time**
2. Compared to disk hash at **write time**
3. Mismatch → `STALE_FILE` error → agent must re-read before retrying

### HITL Gates
Human approval is required for:
- `ELEVATED` commands (shell execution, `rm`, `sudo`, etc.)
- `INTENT_EVOLUTION` writes (agent is adding new behavior, not just refactoring)

---

## Running Tests

```bash
npm test
```

The test suite covers:
- Intent gating (write blocked without intent)
- Scope enforcement (write blocked outside owned_scope)
- .intentignore enforcement
- Stale file / concurrency detection
- Trace ledger writing with content hashes
- Session state machine transitions

---

## Submitting

See the [challenge spec](./challenge.md) for submission requirements.

**Interim (Wednesday):** PDF report + this GitHub repo with `src/hooks/` populated  
**Final (Saturday):** PDF report + demo video + full `.orchestration/` artifacts