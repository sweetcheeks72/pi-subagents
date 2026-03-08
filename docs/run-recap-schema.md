# Run Recap Schema (`run-recap.json`)

Defines the structured output artifact for pi-subagents chain and parallel runs. Provides a standard format for capturing run metadata, task results, evidence, and follow-up actions — enabling downstream consumers (Helios session recaps, Crew handoffs, audit trails) to process run outcomes consistently.

---

## Schema Overview

A `run-recap.json` file captures the outcome of a single `subagent()` invocation — whether single, chain, or parallel. It is produced at run completion and written alongside existing artifacts in the run's artifact directory.

### Relationship to `session-recap-v1`

The `run-recap.json` schema is a **run-level subset** of the session-level `session-recap-v1` schema (`~/.pi/agent/schemas/session-recap-v1.json`). A Helios session may contain multiple subagent runs; each run produces its own `run-recap.json`, and the orchestrator aggregates them into a single `session-recap-v1` artifact at session end.

```
┌─────────────────────────────────────────┐
│          session-recap-v1               │
│  (one per Helios session)               │
│                                         │
│  ┌──────────────┐  ┌──────────────┐     │
│  │ run-recap    │  │ run-recap    │     │
│  │ (chain run)  │  │ (parallel)   │     │
│  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────┘
```

---

## Schema Definition

```jsonc
{
  // Required fields
  "schema_version": "run-recap-v1",    // Schema identifier
  "run_id": "<string>",               // Unique run ID (matches async run ID or generated UUID)
  "run_type": "single | chain | parallel",
  "tasks_executed": [
    {
      "agent": "<string>",            // Agent name (e.g., "scout", "worker")
      "task": "<string>",             // Task description or template
      "outcome": "completed | partial | failed | skipped",
      "duration_ms": 12345,           // Wall-clock duration
      "tokens": {                     // Optional token usage
        "input": 1000,
        "output": 500,
        "total": 1500
      },
      "output_file": "<string>",      // Path to agent output artifact (if any)
      "error": "<string>"             // Error message (if failed)
    }
  ],
  "summary": "<string>",              // One-paragraph description of what the run accomplished
  "evidence": [
    {
      "type": "file | commit | test | log",
      "reference": "<string>",        // Path, SHA, or identifier
      "description": "<string>"       // What this evidence shows
    }
  ],
  "risks": [
    {
      "description": "<string>",
      "severity": "low | medium | high | critical",
      "mitigation": "<string>"        // Optional mitigation strategy
    }
  ],
  "next_steps": [
    {
      "step": "<string>",
      "priority": "immediate | next-session | backlog",
      "owner": "<string>"             // Optional: who should do this
    }
  ],

  // Optional fields
  "chain_agents": ["scout", "worker"],  // Agent sequence (chain runs only)
  "total_steps": 2,                     // Total steps in chain
  "started_at": "2026-03-08T16:00:00Z", // ISO 8601
  "completed_at": "2026-03-08T16:05:00Z",
  "duration_ms": 300000,                // Total run duration
  "total_tokens": { "input": 5000, "output": 2000, "total": 7000 },
  "total_cost": 0.042,                  // USD cost estimate
  "scope_goal": "<string>",            // What the run was trying to accomplish
  "understanding_confirmed": {          // Scope confirmation metadata
    "confirmed": true,
    "method": "interview | inline-message | brief-capture | implicit-proceed | skipped"
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `string` | Always `"run-recap-v1"` |
| `run_id` | `string` | Unique identifier for this run |
| `run_type` | `enum` | `"single"`, `"chain"`, or `"parallel"` |
| `tasks_executed` | `array` | Ordered list of tasks with outcomes |
| `summary` | `string` | Human-readable summary of run outcome |
| `evidence` | `array` | Concrete artifacts produced or referenced |
| `risks` | `array` | Known risks or concerns (empty array if none) |
| `next_steps` | `array` | Recommended follow-up actions (empty array if none) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `chain_agents` | `string[]` | Agent names in execution order (chain runs) |
| `total_steps` | `number` | Total steps (chain runs) |
| `started_at` | `datetime` | ISO 8601 start timestamp |
| `completed_at` | `datetime` | ISO 8601 completion timestamp |
| `duration_ms` | `number` | Total wall-clock duration |
| `total_tokens` | `object` | Aggregated token usage |
| `total_cost` | `number` | Estimated USD cost |
| `scope_goal` | `string` | What the run aimed to accomplish |
| `understanding_confirmed` | `object` | Whether scope was confirmed before launch |

---

## Field Mapping to `session-recap-v1`

When aggregating run recaps into a session recap, map fields as follows:

| `run-recap` Field | `session-recap-v1` Field | Mapping Notes |
|---|---|---|
| `run_id` | `session_id` | Session recap uses session ID; run_id referenced in evidence |
| `run_type` | `session_type` | `chain`/`parallel` → `"implementation"` or contextual type |
| `scope_goal` | `scope_goal_statement` | Direct mapping |
| `understanding_confirmed` | `understanding_confirmed` | Direct mapping (same shape) |
| `tasks_executed` | `actions_taken` | Map: `agent + task` → `action`, `outcome` → `outcome` |
| `summary` | (aggregated into session summary) | Concatenate or synthesize across runs |
| `evidence` | `evidence_artifacts` | Direct mapping; `evidence.type` maps to same enum subset |
| `risks` | `risks_blockers` | Direct mapping; same severity enum |
| `next_steps` | `next_steps` | Direct mapping; same priority enum |
| `chain_agents` | `substrate_used` | `chain` → `"lite-subagent"`, `parallel` → `"lite-subagent"` |
| `duration_ms` | `duration_minutes` | Convert: `duration_ms / 60000` |
| `completed_at` | `created_at` | Use run completion time or session end time |

### Aggregation Rules

1. **Multiple runs in one session:** Each run's `tasks_executed` entries become `actions_taken` entries in the session recap. Evidence arrays are concatenated and deduplicated by reference.
2. **Risk merging:** Risks from all runs are merged; duplicates (same description) are collapsed, keeping the highest severity.
3. **Next steps:** Merged and deduplicated; `"immediate"` priority items from later runs may supersede `"backlog"` items from earlier runs.

---

## `--recap-output` Convention

Subagent invocations can request a run recap via an optional `--recap-output` convention. This is a **Phase 1 documentation convention** — no source code changes are required yet.

### Proposed Usage

```typescript
// Single agent with recap output
subagent({
  agent: "worker",
  task: "Implement auth middleware",
  recapOutput: "run-recap.json"  // Write recap to {artifact_dir}/run-recap.json
});

// Chain with recap
subagent({
  chain: [
    { agent: "scout", task: "Analyze codebase" },
    { agent: "worker", task: "Implement based on {previous}" }
  ],
  recapOutput: true  // Write recap to default location
});

// Parallel with recap
subagent({
  tasks: [
    { agent: "worker", task: "Task A" },
    { agent: "worker", task: "Task B" }
  ],
  recapOutput: "parallel-recap.json"
});
```

### Default Output Location

When `recapOutput` is `true` (no explicit path):
- **Async runs:** `~/.pi/subagent-runs/{run_id}/run-recap.json`
- **Sync runs:** Written to the artifact directory alongside other outputs
- **Chain runs:** Written after the final step completes

### When to Enable

| Scenario | Recap? | Rationale |
|----------|--------|-----------|
| Scout-only recon | No | Lightweight; output is the response itself |
| Single worker task | Optional | Useful for audit trail |
| Chain (scout → worker) | Yes | Captures multi-step outcome with evidence |
| Parallel workers | Yes | Aggregates results across concurrent tasks |
| Crew-dispatched runs | Yes | Feeds into Crew task completion evidence |

---

## Example: Chain Run Recap

```json
{
  "schema_version": "run-recap-v1",
  "run_id": "chain-a1b2c3d4",
  "run_type": "chain",
  "chain_agents": ["scout", "worker"],
  "total_steps": 2,
  "scope_goal": "Add rate limiting middleware to API routes",
  "understanding_confirmed": {
    "confirmed": true,
    "method": "interview"
  },
  "tasks_executed": [
    {
      "agent": "scout",
      "task": "Analyze existing middleware patterns in src/middleware/",
      "outcome": "completed",
      "duration_ms": 8500,
      "tokens": { "input": 2100, "output": 800, "total": 2900 },
      "output_file": "context.md"
    },
    {
      "agent": "worker",
      "task": "Implement rate limiter based on scout findings",
      "outcome": "completed",
      "duration_ms": 45000,
      "tokens": { "input": 8500, "output": 3200, "total": 11700 },
      "output_file": "implementation.md"
    }
  ],
  "summary": "Added token-bucket rate limiter at src/middleware/rate-limit.ts with per-route configuration. Integrated with existing auth middleware chain. Tests added for burst and sustained traffic patterns.",
  "evidence": [
    { "type": "file", "reference": "src/middleware/rate-limit.ts", "description": "Rate limiter implementation" },
    { "type": "file", "reference": "src/middleware/rate-limit.test.ts", "description": "Unit tests (12 passing)" },
    { "type": "commit", "reference": "abc1234", "description": "feat(middleware): add rate limiting" }
  ],
  "risks": [
    {
      "description": "In-memory token bucket state is lost on process restart",
      "severity": "medium",
      "mitigation": "Add Redis-backed store in Phase 2"
    }
  ],
  "next_steps": [
    { "step": "Add Redis backing store for distributed rate limiting", "priority": "next-session", "owner": "helios" },
    { "step": "Configure per-route rate limits in API config", "priority": "immediate", "owner": "user" }
  ],
  "started_at": "2026-03-08T16:00:00Z",
  "completed_at": "2026-03-08T16:01:23Z",
  "duration_ms": 53500,
  "total_tokens": { "input": 10600, "output": 4000, "total": 14600 },
  "total_cost": 0.038
}
```

---

## Schema References

- **Authoritative session schema:** `~/.pi/agent/schemas/session-recap-v1.json`
- **Rendering modes:** `~/.pi/agent/docs/recap-rendering-modes.md`
- **Visual template:** `~/.pi/agent/templates/recap-visual.html`
- **Markdown template:** `~/.pi/agent/templates/recap-markdown.md`
