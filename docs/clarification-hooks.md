# Clarification Hooks: Pre-Launch Scope Confirmation

Documents the `confirmScope` convention for pi-subagents — a pre-launch scope confirmation step that ensures the orchestrator and user agree on what a subagent run will accomplish before execution begins.

---

## Problem Statement

Helios sometimes launches subagent runs without verifying its understanding of the user's intent. This leads to:

1. **Wasted compute** — agent runs that solve the wrong problem
2. **Silent misalignment** — correct execution of an incorrect interpretation
3. **Over-trust in preflight** — GSD-lite lane selection (lite/full) confirms *how* to execute, not *what* to execute

The `confirmScope` hook addresses this by inserting a lightweight scope-confirmation step between task interpretation and subagent dispatch.

---

## `confirmScope` Configuration

### Agent Frontmatter

Add `confirmScope: true` to an agent's YAML frontmatter to require scope confirmation before the agent runs:

```yaml
---
name: architect
description: Architecture analysis and recommendations
model: claude-sonnet-4-5
confirmScope: true
---

Analyze the architecture and recommend improvements...
```

### Inline Configuration

Override per-invocation via the `subagent()` call:

```typescript
// Enable scope confirmation for this run
subagent({
  agent: "worker",
  task: "Refactor auth module to use JWT",
  confirmScope: true
});

// Disable even if agent frontmatter has it enabled
subagent({
  agent: "architect",
  task: "Quick check on file structure",
  confirmScope: false
});

// Chain with scope confirmation before first step
subagent({
  chain: [
    { agent: "scout", task: "Analyze {task}" },
    { agent: "worker", task: "Implement based on {previous}" }
  ],
  confirmScope: true  // Confirms before the chain starts, not per-step
});
```

### Precedence Rules

1. Inline `confirmScope` parameter (highest priority)
2. Agent frontmatter `confirmScope` field
3. Default: `false` (no confirmation)

---

## Interview Integration Path

When `confirmScope: true` is active, the orchestrator presents scope confirmation via the `interview` tool before dispatching:

### Confirmation Flow

```
User request → Helios interprets scope → confirmScope check
                                              │
                              ┌────────────────┼────────────────┐
                              │                │                │
                        confirmScope:     confirmScope:    confirmScope:
                           true              false         (default)
                              │                │                │
                              ▼                ▼                ▼
                     Present interview    Skip, dispatch    Skip, dispatch
                              │
                              ▼
                     User confirms/adjusts
                              │
                              ▼
                     Dispatch with confirmed scope
```

### Interview Template

The scope confirmation interview uses a lightweight format:

```jsonc
{
  "title": "Scope Confirmation",
  "description": "Review the planned approach before execution",
  "questions": [
    {
      "id": "scope",
      "type": "single",
      "question": "I understand the goal as: \"<interpreted scope>\". Is this correct?",
      "options": [
        "Yes, proceed as described",
        "Mostly right, but adjust: <details>",
        "No, I meant something different"
      ],
      "recommended": "Yes, proceed as described"
    },
    {
      "id": "substrate",
      "type": "single",
      "question": "Planned execution: <substrate> with <agent(s)>",
      "options": [
        "Looks good",
        "Use a different approach"
      ],
      "recommended": "Looks good",
      "weight": "minor"
    }
  ]
}
```

### Recording Confirmation

The confirmation result is recorded in the run recap's `understanding_confirmed` field:

```json
{
  "understanding_confirmed": {
    "confirmed": true,
    "method": "interview",
    "details": "User confirmed: refactor auth to JWT, keep backward compat for 2 weeks"
  }
}
```

This maps directly to the `session-recap-v1` schema's `understanding_confirmed` field, which uses the same shape and enum values.

---

## When to Use `confirmScope`

### Appropriate

| Scenario | Why |
|----------|-----|
| **Ambiguous user requests** | "Fix the auth" — fix what? Refactor, patch a bug, add a feature? |
| **High-cost runs** | Multi-agent chains or parallel dispatches that consume significant tokens |
| **Destructive operations** | Refactors, deletions, schema migrations — hard to undo |
| **Multi-step chains** | Confirming the full chain plan before committing to step 1 |
| **Architecture decisions** | Choices with long-term consequences deserve explicit confirmation |
| **First run in a session** | User intent is freshest; misalignment costs compound |

### Not Appropriate

| Scenario | Why |
|----------|-----|
| **Scout/recon runs** | Low cost, low risk, read-only — just run it |
| **Explicit, unambiguous tasks** | "Run `npm test`" — no interpretation needed |
| **Follow-up runs** | Scope was already confirmed in a previous run this session |
| **Trivial single-agent tasks** | Quick lookups, file reads, simple edits with clear intent |
| **Automated/programmatic dispatch** | CI pipelines, scheduled runs — no user to confirm with |
| **Inside Crew worker execution** | Worker tasks are already scoped by the Crew planner |

### Anti-Patterns

- ❌ **Confirming every run** — creates friction; reserve for ambiguous or high-stakes scenarios
- ❌ **Using confirmScope as a substitute for good task descriptions** — write clear tasks instead
- ❌ **Treating GSD-lite preflight as scope confirmation** — preflight selects the *lane* (lite vs full), not the *goal*
- ❌ **Confirming inside chain steps** — confirm once before the chain, not per-step
- ❌ **Skipping confirmation on destructive operations** — even if the task seems clear

---

## Relationship to Existing Mechanisms

### vs. `clarify` TUI

The existing `clarify: true` parameter opens the chain/single clarification TUI for editing templates, models, and execution parameters. `confirmScope` is different:

| Aspect | `clarify` | `confirmScope` |
|--------|-----------|----------------|
| **What it confirms** | Execution parameters (model, output, skills) | User intent and scope |
| **When it appears** | Before agent launch | Before agent launch |
| **Who adjusts** | User edits agent config | User confirms/corrects interpretation |
| **Format** | TUI overlay | Interview form |
| **Can coexist** | — | Yes — confirmScope runs first, then clarify TUI |

### vs. GSD-Lite Preflight

GSD-lite determines *how* to execute (lite lane vs. full collaboration). `confirmScope` determines *what* to execute. They are complementary:

```
User request
    → GSD-lite preflight (select lane)        ← "How should we execute?"
    → confirmScope (if enabled)               ← "Is this what you want?"
    → clarify TUI (if enabled)                ← "With these parameters?"
    → dispatch
```

### vs. `session-recap-v1` `understanding_confirmed`

The `understanding_confirmed` field in `session-recap-v1` records *whether* confirmation happened. `confirmScope` is the mechanism that *performs* the confirmation. The recap field is the audit trail; the hook is the action.

---

## Configuration Reference

### Agent Frontmatter Fields

```yaml
confirmScope: true           # Require scope confirmation before dispatch
# confirmScope: false        # Explicitly disable (same as omitting)
```

### Subagent Parameter

```typescript
subagent({
  agent: "name",
  task: "description",
  confirmScope: true | false  // Override agent frontmatter
});
```

### Environment Override

```bash
# Disable all scope confirmations (e.g., in CI)
PI_SUBAGENT_CONFIRM_SCOPE=false
```

---

## Schema References

- **Session recap schema:** `~/.pi/agent/schemas/session-recap-v1.json` — `understanding_confirmed` field
- **Run recap schema:** `./run-recap-schema.md` — `understanding_confirmed` and `scope_goal` fields
- **Rendering modes:** `~/.pi/agent/docs/recap-rendering-modes.md`
