# CLAUDE.md — Shared Agent Brain

This file is a persistent knowledge base shared across ALL parallel agent sessions
(Architect / Builder / Tester). It is automatically updated when agents encounter
failures or make architectural decisions.

**READ THIS at the start of every session** before writing any code.

---

## Project Overview

This is a governed AI-Native IDE — a fork of Roo Code instrumented with an
Intent-Code Traceability hook system. The codebase enforces mandatory intent
declaration before any file mutation.

## Core Rules (Never Violate)

1. **Always call `select_active_intent` first** — no exceptions.
2. **Stay within `owned_scope`** — call `expand_intent_scope` if you need more.
3. **Classify every write** — `AST_REFACTOR`, `INTENT_EVOLUTION`, `BUG_FIX`, etc.
4. **Re-read before retry** — if you get `STALE_FILE`, read the file again.
5. **Record lessons** — call `record_lesson` immediately when something fails.

## Architectural Decisions

### 2026-02-18 — Chosen Content Hashing Strategy
Used SHA-256 on raw string content for spatial independence.
Line numbers are not part of the hash — only the content block matters.
This means a hash remains valid even if surrounding lines shift.

### 2026-02-18 — Optimistic Locking Protocol
Snapshot file hashes at READ time, validate at WRITE time.
No file-system locks used — lock-free by design for parallel agents.
If hash mismatch detected → STALE_FILE error → agent must re-read.

### 2026-02-18 — HITL Trigger Conditions
- ELEVATED commands (shell execution) → always HITL
- INTENT_EVOLUTION writes → HITL if HITL is enabled
- Pure AST_REFACTOR within scope → no HITL required

## Lessons Learned

_(Automatically appended by the Hook Engine when verification fails)_

---