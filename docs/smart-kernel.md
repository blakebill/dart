# Dart Smart Selection

## Purpose

Smart is Dart's adaptive outbound-selection mode. It aims to keep an available,
responsive route without treating a single latency sample as complete evidence.
The application owns the preferred-node decision so the node badge, active
selection, diagnostics, and runtime state remain consistent.

Smart operates in two layers:

- The application evaluates nodes, schedules probes, learns from recent
  sessions, and applies the preferred node through the local runtime API.
- A compatible Dart runtime may provide connection-level failover and report
  additional observations. The application remains the source of truth for the
  preferred node.

When runtime enhancement is unavailable, Smart continues to work entirely
through application-managed selection.

## Inputs

Smart uses bounded, non-sensitive observations:

| Signal | Use |
| --- | --- |
| Primary probe RTT | Main responsiveness signal and the delay shown in the UI |
| Secondary probe RTT | Reduces dependence on one destination |
| Jitter and robust cohort spread | Penalizes unstable results without allowing one outlier to dominate |
| Probe failures | Applies cooldown and availability penalties |
| Connection outcomes | Records successful traffic and repeated soft failures |
| Recent traffic evidence | Reduces uncertainty for nodes proven by real use |
| Current selection | Adds dwell and confirmation protection against unnecessary switching |
| Network context | Separates history by profile, runtime, and network environment |

Probe destinations and known diagnostic traffic are excluded from connection
feedback. Explicit UDP observations that cannot provide useful response
evidence are ignored.

## Selection Model

Each node keeps a compact, decaying history:

- Smoothed RTT and jitter
- Success and failure counts
- Consecutive-failure state
- Cooldown deadline
- Last observation time
- Probe and real-traffic evidence

Old evidence decays so a node can recover and a changed network does not remain
anchored to stale measurements. Node identity is derived from stable connection
properties rather than the display name, allowing harmless renames without
sharing history with a materially different endpoint.

The final selection cost combines responsiveness, stability, failure risk,
cooldown state, and mode-specific weights. Exploration uses a discounted
UCB-V-style score only to decide which nodes should be probed. Uncertainty alone
can never make a node the active route.

## Switching Rules

Smart applies the following protections:

1. An unavailable or repeatedly failing current node can be replaced
   immediately.
2. A healthy challenger must win consecutive evaluation rounds before a
   switch.
3. Small improvements are ignored to avoid oscillation.
4. Correlated failures across many nodes are treated as a probable local
   outage instead of penalizing every node independently.
5. A user override pins the selected node to the active Smart group and clears
   automatically after repeated probe failures.

The three user modes adjust weighting rather than changing the model:

- **Balanced**: normal responsiveness and stability weights.
- **Low latency**: reacts faster to a consistently quicker healthy node.
- **Stability first**: gives stronger weight to jitter, failures, and dwell.

## Region Scope

The Settings view can restrict Smart to selected regions. Region codes are
inferred locally from subscription node flags, common location labels, and
country-code server domains; node endpoints are not sent to another service.
The resulting allowlist is applied to the generated Smart group for both
Mihomo, so runtime membership, background probes, selection, and
force overrides all use the same candidate set.

An empty allowlist means all regions. If a later subscription refresh renames
every matching node, Smart temporarily falls back to all nodes instead of
generating an empty group that cannot start. The saved preference remains in
place and becomes active again when matching nodes return.

## Probe Scheduling

Probe work is bounded:

- Active Smart normally evaluates a rotating candidate batch.
- The current winner, unseen nodes, recovery candidates, and a forced override
  receive priority.
- Stable sessions move to a relaxed interval.
- Failures or insufficient evidence move to an urgent interval.
- Primary results use a short cache; secondary results use a longer independent
  cache.
- Probe concurrency is fixed internally to prevent an invalid setting from
  overwhelming the runtime or network.

Only the primary probe delay is displayed on node cards. The internal blended
value may differ because it includes secondary and stability evidence.

## Runtime Enhancement

A compatible Dart runtime can add connection-level behavior that is unsafe or
impossible to implement after a connection has already been returned to the
application:

- Retry another candidate when a dial fails before application data is sent.
- Record dial or first-write outcomes for subsequent decisions.
- Keep connection-level failover local to the runtime.

Already-sent application data is never replayed automatically. Replaying bytes
could duplicate requests or violate protocol state. First-write failures are
therefore recorded for future selection unless the runtime can prove that no
application data was accepted.

The application detects runtime capability from a real configuration probe.
Release names and version strings are advisory only and do not enable features
by themselves.

## State and Privacy

Smart history is session-scoped and bounded. It is cleared when the application
closes and separated when the active profile, runtime, or network context
changes. Stored profile data does not gain Smart telemetry.

The renderer receives node names and limited presentation metadata, not server
addresses. Smart observations remain in the main process and are not included
in exported diagnostics or backups unless a future export explicitly documents
them.

## Limits

- URL RTT cannot fully predict application throughput.
- Connection snapshots cannot provide complete packet-loss or UDP response
  measurements.
- Multiplexed traffic provides fewer independent observations than separate
  connections.
- A local outage can delay useful scoring until probes recover.
- Connection-level replay after application data has been sent is intentionally
  unsupported.

These limits are handled conservatively: Smart prefers bounded exploration,
decaying evidence, and stable switching over aggressive prediction.

## Verification

Changes to Smart should cover:

- Cold start and clear-winner selection
- Stable-node dwell and challenger confirmation
- Failure cooldown and recovery
- Context and profile isolation
- Outlier-resistant cohort scoring
- Probe-only exploration
- Override lifecycle
- Runtime capability fallback
- Cancellation of in-flight work after stop or profile change
- Bounded history, candidate batches, and timers
