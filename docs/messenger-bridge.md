# Messenger Bridge: pi-subagents ↔ pi-messenger Interoperation

Design document for bridging pi-subagents and pi-messenger, enabling shared run metadata, coordinated file reservations, message passing, and durable context packets across both execution substrates.

---

## Motivation

pi-subagents and pi-messenger serve different coordination roles:

| Aspect | pi-subagents | pi-messenger (Crew) |
|--------|-------------|---------------------|
| **Lifecycle** | Ephemeral — one run, auto-cleanup | Persistent — durable task store across sessions |
| **Coordination** | File-based (subagent mesh, `{chain_dir}`) | Action-based (`join`, `send`, `reserve`, `task.done`) |
| **Task model** | Flat (single/chain/parallel) | Graph (dependencies, priorities, waves) |
| **Use case** | One-off delegation, throwaway parallelism | Multi-wave orchestration, long-horizon projects |

Today these substrates are **isolated**: a subagent run cannot announce its reservations to the Crew mesh, and a Crew worker cannot consume a subagent run's recap artifact without manual copying. The bridge closes this gap.

---

## Integration Points

### 1. Shared Run Metadata

**Problem:** When Helios dispatches a subagent run within a Crew task, the run metadata (agent, duration, tokens, outcome) is not visible in the Crew task's progress log.

**Bridge Design:**

```
Crew task (in_progress)
    → subagent() dispatch
        → run completes → produces run-recap.json
    → bridge writes run metadata to Crew task progress
    → bridge attaches run-recap.json to Crew task artifacts
```

**Specific Hook: `onRunComplete`**

When a subagent run completes, the bridge:

1. Checks if the current context is inside a Crew task (detects `TASK_ID` environment variable or `.pi/messenger/crew/` presence)
2. If yes, writes a progress entry to the task's `.progress.md`:
   ```
   [2026-03-08T16:05:00Z] (subagent) chain run chain-a1b2c3d4 completed: scout → worker, 53.5s, 14600 tokens
   ```
3. Copies `run-recap.json` to `.pi/messenger/crew/artifacts/{task-id}/run-recap-{run-id}.json`
4. If no Crew context, the run recap stays in the subagent artifact directory only

**Data Format (progress entry):**

```jsonc
{
  "timestamp": "2026-03-08T16:05:00Z",
  "source": "subagent",
  "run_id": "chain-a1b2c3d4",
  "run_type": "chain",
  "agents": ["scout", "worker"],
  "outcome": "completed",
  "duration_ms": 53500,
  "tokens": 14600,
  "recap_path": ".pi/messenger/crew/artifacts/task-5/run-recap-chain-a1b2c3d4.json"
}
```

---

### 2. Reservation/Check Hooks

**Problem:** A subagent worker may edit files that a Crew worker has reserved, or vice versa. Neither system checks the other's reservations.

**Bridge Design:**

```
                    ┌─────────────────┐
                    │  Unified Check  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼                             ▼
   pi-messenger reservations      subagent-mesh reservations
   .pi/messenger/reservations/    ~/.pi/subagent-mesh/{run}/reservations.json
```

**Specific Hooks:**

#### `preReserve` — Check before reserving

Before a subagent mesh worker reserves a file, the bridge checks pi-messenger reservations:

```typescript
// Bridge pseudo-code
async function preReserve(paths: string[], runId: string): Promise<ReserveResult> {
  // Check subagent mesh reservations (existing behavior)
  const meshConflicts = checkMeshReservations(paths, runId);

  // NEW: Also check pi-messenger Crew reservations
  const crewReservations = readCrewReservations();  // .pi/messenger/reservations/
  const crewConflicts = paths.filter(p =>
    crewReservations.some(r => r.path === p && r.agent !== currentAgent)
  );

  if (crewConflicts.length > 0) {
    return {
      allowed: false,
      conflicts: crewConflicts.map(p => ({
        path: p,
        holder: crewReservations.find(r => r.path === p).agent,
        system: "crew"
      }))
    };
  }

  return { allowed: true };
}
```

#### `onReserve` — Mirror reservations

When a subagent mesh worker reserves files, optionally mirror to Crew:

```typescript
// Bridge pseudo-code
async function onReserve(paths: string[], agent: string, runId: string) {
  // Write to subagent mesh (existing behavior)
  writeMeshReservation(paths, agent, runId);

  // NEW: If inside a Crew task context, also register with Crew
  if (hasCrewContext()) {
    await crewReserve(paths, `subagent:${agent}:${runId}`);
  }
}
```

#### `onRelease` — Clean up mirrored reservations

```typescript
async function onRelease(agent: string, runId: string) {
  releaseMeshReservation(agent, runId);

  if (hasCrewContext()) {
    await crewRelease(`subagent:${agent}:${runId}`);
  }
}
```

**Conflict Resolution Rules:**

1. Crew reservations take priority over subagent mesh reservations (Crew is the durable system)
2. If a subagent run needs a Crew-reserved file, it must message the Crew worker via the inbox bridge (see §3)
3. Subagent mesh reservations auto-expire when the run completes; Crew reservations require explicit release

---

### 3. Inbox / Message Bridge

**Problem:** A subagent worker cannot send messages to Crew workers, and vice versa. Cross-substrate communication requires manual intervention.

**Bridge Design:**

```
Subagent Worker                         Crew Worker
      │                                      │
      │  bridge.send("CrewAgent", msg)        │
      ├──────────────────────────────────────►│
      │      (writes to Crew inbox)           │
      │                                      │
      │      bridge.send("SubAgent", msg)     │
      │◄──────────────────────────────────────┤
      │      (writes to mesh feed)            │
      │                                      │
```

**Specific Hooks:**

#### Subagent → Crew messaging

```typescript
// From inside a subagent worker, send to a Crew agent
async function sendToCrewAgent(to: string, message: string, from: string) {
  const inbox = `.pi/messenger/inbox/${to}.jsonl`;
  appendJsonl(inbox, {
    from: `subagent:${from}`,
    to,
    message,
    timestamp: new Date().toISOString(),
    source_system: "subagent-mesh",
    run_id: currentRunId
  });
}
```

#### Crew → Subagent messaging

```typescript
// From a Crew worker, send to a running subagent mesh
async function sendToSubagent(runId: string, agentName: string, message: string, from: string) {
  const feed = `~/.pi/subagent-mesh/${runId}/feed.jsonl`;
  appendJsonl(feed, {
    type: "message",
    from: `crew:${from}`,
    to: agentName,
    message,
    timestamp: new Date().toISOString()
  });
}
```

**Limitations (Phase 1):**

- Messages are fire-and-forget — no delivery confirmation
- Subagent mesh runs are ephemeral; messages sent to completed runs are lost
- No real-time notification — recipients poll their inbox/feed
- Cross-substrate messaging is best-effort; for reliable coordination, use a single substrate

---

### 4. Durable Context Packet Format

**Problem:** When work transitions between substrates (e.g., a Crew task spawns subagent runs, or a subagent run's output feeds into a Crew task), context is lost at the boundary.

**Bridge Design: Context Packet**

A context packet is a self-contained JSON artifact that captures the state of work at a substrate boundary, enabling the receiving substrate to resume without re-reading the source's internal state.

```jsonc
{
  "schema_version": "context-packet-v1",
  "packet_id": "<uuid>",
  "created_at": "2026-03-08T16:05:00Z",

  // Source context
  "source": {
    "system": "subagent | crew",
    "run_id": "<string>",           // Subagent run ID or Crew task ID
    "agent": "<string>",            // Agent that produced this context
    "task_summary": "<string>"      // What was being worked on
  },

  // Target context
  "target": {
    "system": "subagent | crew",
    "task_id": "<string>",          // Optional: target Crew task ID
    "suggested_agent": "<string>"   // Optional: recommended agent to consume this
  },

  // Payload
  "scope_goal": "<string>",         // What needs to be accomplished
  "understanding_confirmed": {       // Was scope confirmed? (maps to session-recap-v1)
    "confirmed": true,
    "method": "interview",
    "details": "<string>"
  },
  "context_files": [                 // Files the target should read
    {
      "path": "<string>",
      "description": "<string>",
      "content_hash": "<string>"    // SHA-256 for staleness detection
    }
  ],
  "key_findings": ["<string>"],     // Carry forward from run recap
  "risks": [                        // Carry forward from run recap
    {
      "description": "<string>",
      "severity": "low | medium | high | critical"
    }
  ],
  "decisions_made": [               // Decisions the target should respect
    {
      "decision": "<string>",
      "rationale": "<string>",
      "confirmed_by": "user | agent | implicit"
    }
  ],
  "next_steps": [                   // What the target should do
    {
      "step": "<string>",
      "priority": "immediate | next-session | backlog"
    }
  ],

  // Evidence chain
  "evidence": [
    {
      "type": "file | commit | test | log | run-recap",
      "reference": "<string>",
      "description": "<string>"
    }
  ]
}
```

**Storage Location:**

| Transition | Packet Location |
|-----------|----------------|
| Subagent → Crew | `.pi/messenger/crew/artifacts/{task-id}/context-packet-{packet-id}.json` |
| Crew → Subagent | `{chain_dir}/context-packet.json` (read via `defaultReads`) |
| Subagent → Subagent | `{chain_dir}/context-packet.json` (standard chain handoff) |
| Crew → Crew | `.pi/messenger/crew/artifacts/{task-id}/context-packet-{packet-id}.json` |

**Staleness Detection:**

Context packets include `content_hash` for referenced files. The consuming agent can verify that files haven't changed since the packet was created:

```typescript
// Consumer-side staleness check
function checkPacketFreshness(packet: ContextPacket): StaleFile[] {
  return packet.context_files
    .filter(f => sha256(readFile(f.path)) !== f.content_hash)
    .map(f => ({ path: f.path, status: "stale" }));
}
```

If stale files are detected, the consumer should:
1. Log a warning in its progress
2. Re-read the stale files for current content
3. Note the staleness in its own run recap

---

## Integration Summary

```
┌──────────────────────────────────────────────────────────────┐
│                    Messenger Bridge                           │
│                                                              │
│  ┌─────────────┐    Shared Metadata    ┌─────────────────┐  │
│  │ pi-subagents │◄────────────────────►│  pi-messenger    │  │
│  │              │    Reservation Hooks  │  (Crew)          │  │
│  │  run-recap   │◄────────────────────►│  task progress   │  │
│  │  mesh feed   │    Message Bridge     │  inbox           │  │
│  │  chain_dir   │◄────────────────────►│  artifacts       │  │
│  │              │    Context Packets    │                  │  │
│  └─────────────┘                       └─────────────────┘  │
│                                                              │
│  Common Layer:                                               │
│  • session-recap-v1 schema (authoritative)                   │
│  • run-recap-v1 schema (subagent-level)                      │
│  • context-packet-v1 format (cross-substrate)                │
│  • understanding_confirmed (shared shape)                    │
└──────────────────────────────────────────────────────────────┘
```

---

## Phase 1 vs Phase 2

### Phase 1 (This Document — Docs Only)

- ✅ Define all integration points and data formats
- ✅ Document reservation check hooks with pseudo-code
- ✅ Design context packet format
- ✅ Specify message bridge protocol
- ❌ No source code changes
- ❌ No runtime bridge implementation

### Phase 2 (Future — Implementation)

| Component | Implementation Location | Priority |
|-----------|------------------------|----------|
| `onRunComplete` hook | `pi-subagents/execution.ts` | High |
| `preReserve` cross-check | `pi-subagents/subagent-mesh/` + `pi-messenger/handlers.ts` | High |
| Context packet writer | `pi-subagents/artifacts.ts` | Medium |
| Message bridge | New `pi-subagents/messenger-bridge.ts` | Medium |
| Reservation mirroring | `pi-subagents/subagent-mesh/` | Low |
| Staleness detection | Shared utility | Low |

### Phase 2 Prerequisites

1. Both extensions must agree on reservation file format (currently different)
2. pi-messenger must expose a programmatic API (not just `pi_messenger()` tool calls)
3. Context packet schema should be formalized as JSON Schema (like `session-recap-v1`)
4. Subagent mesh feed format must be documented (currently implicit)

---

## Schema References

- **Session recap schema:** `~/.pi/agent/schemas/session-recap-v1.json`
- **Run recap schema:** `./run-recap-schema.md`
- **Clarification hooks:** `./clarification-hooks.md`
- **Rendering modes:** `~/.pi/agent/docs/recap-rendering-modes.md`
- **Handoff policy:** `~/.pi/agent/HANDOFF_POLICY.md` — substrate selection matrix
- **Subagent mesh protocol:** Defined in pi-subagents subagent-mesh extension (file-based coordination)
- **Crew protocol:** Defined in pi-messenger Crew module (action-based coordination)
