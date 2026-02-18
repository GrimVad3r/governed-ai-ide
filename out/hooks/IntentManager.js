"use strict";
// ============================================================
// IntentManager.ts — CRUD for active_intents.yaml
// ============================================================
// Purpose: Single source of truth for loading, querying, and
// updating the intent specification file. Treats the codebase
// as a collection of formalized intents, not just text files.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntentManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
const minimatch_1 = require("minimatch");
class IntentManager {
    constructor(config) {
        this.config = config;
        this.intentsPath = path.join(config.orchestrationDir, "active_intents.yaml");
        this.intentMapPath = path.join(config.orchestrationDir, "intent_map.md");
    }
    // ── Read ──────────────────────────────────────────────────
    /** Load and parse the full intents file */
    loadAll() {
        if (!fs.existsSync(this.intentsPath)) {
            return { active_intents: [] };
        }
        const raw = fs.readFileSync(this.intentsPath, "utf8");
        const parsed = yaml.load(raw);
        return parsed ?? { active_intents: [] };
    }
    /** Get a specific intent by ID */
    getById(intentId) {
        const { active_intents } = this.loadAll();
        return active_intents.find((i) => i.id === intentId) ?? null;
    }
    /** Get all intents with a given status */
    getByStatus(status) {
        const { active_intents } = this.loadAll();
        return active_intents.filter((i) => i.status === status);
    }
    /** Validate that an intent ID exists and is actionable */
    isValidIntent(intentId) {
        const intent = this.getById(intentId);
        if (!intent)
            return false;
        return intent.status !== "COMPLETE" && intent.status !== "ABANDONED";
    }
    // ── Scope Enforcement ────────────────────────────────────
    /**
     * Check if a file path is within the owned_scope of an intent.
     * owned_scope entries are glob patterns relative to workspace root.
     */
    isFileInScope(intentId, filePath) {
        const intent = this.getById(intentId);
        if (!intent)
            return false;
        // Normalize path relative to workspace root
        const relPath = path.isAbsolute(filePath)
            ? path.relative(this.config.workspaceRoot, filePath)
            : filePath;
        return intent.owned_scope.some((pattern) => (0, minimatch_1.minimatch)(relPath, pattern, { matchBase: true, dot: true }));
    }
    // ── Write ─────────────────────────────────────────────────
    /** Persist the full intents object back to YAML */
    save(data) {
        const yamlStr = yaml.dump(data, {
            indent: 2,
            lineWidth: 120,
            noRefs: true,
        });
        fs.mkdirSync(path.dirname(this.intentsPath), { recursive: true });
        fs.writeFileSync(this.intentsPath, yamlStr, "utf8");
    }
    /** Update a single field on an existing intent */
    updateIntent(intentId, updates) {
        const data = this.loadAll();
        const idx = data.active_intents.findIndex((i) => i.id === intentId);
        if (idx === -1)
            return false;
        data.active_intents[idx] = {
            ...data.active_intents[idx],
            ...updates,
            updated_at: new Date().toISOString(),
        };
        this.save(data);
        return true;
    }
    /** Mark an intent as IN_PROGRESS when an agent selects it */
    markInProgress(intentId) {
        return this.updateIntent(intentId, { status: "IN_PROGRESS" });
    }
    /** Mark an intent as COMPLETE */
    markComplete(intentId) {
        return this.updateIntent(intentId, { status: "COMPLETE" });
    }
    /** Add a new intent programmatically */
    addIntent(intent) {
        const data = this.loadAll();
        const exists = data.active_intents.some((i) => i.id === intent.id);
        if (exists)
            throw new Error(`Intent ${intent.id} already exists`);
        data.active_intents.push({
            ...intent,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
        this.save(data);
    }
    // ── Context Building ─────────────────────────────────────
    /**
     * Build the XML context block injected into the LLM prompt.
     * This is the core of the "Reasoning Intercept" — it gives the
     * agent deep, structured knowledge before it writes a single line.
     */
    buildContextBlock(intentId) {
        const intent = this.getById(intentId);
        if (!intent) {
            return `<intent_context>\n  <error>Intent ${intentId} not found</error>\n</intent_context>`;
        }
        const constraintLines = intent.constraints
            .map((c) => `    <constraint>${c}</constraint>`)
            .join("\n");
        const scopeLines = intent.owned_scope
            .map((s) => `    <glob>${s}</glob>`)
            .join("\n");
        const criteriaLines = intent.acceptance_criteria
            .map((ac) => `    <criterion>${ac}</criterion>`)
            .join("\n");
        const relatedLines = (intent.related_requirements ?? [])
            .map((r) => `    <requirement>${r}</requirement>`)
            .join("\n");
        return `<intent_context>
  <id>${intent.id}</id>
  <name>${intent.name}</name>
  <status>${intent.status}</status>
  <owned_scope>
${scopeLines}
  </owned_scope>
  <constraints>
${constraintLines}
  </constraints>
  <acceptance_criteria>
${criteriaLines}
  </acceptance_criteria>
  <related_requirements>
${relatedLines}
  </related_requirements>
  <directive>
    You MUST only modify files matching the owned_scope globs above.
    Any write outside this scope will be BLOCKED. Request scope expansion
    via the expand_intent_scope tool if needed.
    Classify every file mutation as one of:
    AST_REFACTOR | INTENT_EVOLUTION | BUG_FIX | DOCUMENTATION | TEST | CONFIG
  </directive>
</intent_context>`;
    }
    // ── Intent Map ────────────────────────────────────────────
    /** Append or update an entry in intent_map.md */
    updateIntentMap(intentId, intentName, files) {
        let existing = "";
        if (fs.existsSync(this.intentMapPath)) {
            existing = fs.readFileSync(this.intentMapPath, "utf8");
        }
        const header = `## ${intentId}: ${intentName}`;
        const fileList = files.map((f) => `- \`${f}\``).join("\n");
        const entry = `\n${header}\n_Updated: ${new Date().toISOString()}_\n\n${fileList}\n`;
        // Replace existing entry or append
        const regex = new RegExp(`##\\s+${intentId}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`, "g");
        const updated = existing.match(regex)
            ? existing.replace(regex, entry)
            : existing + entry;
        fs.mkdirSync(path.dirname(this.intentMapPath), { recursive: true });
        fs.writeFileSync(this.intentMapPath, updated, "utf8");
    }
}
exports.IntentManager = IntentManager;
//# sourceMappingURL=IntentManager.js.map