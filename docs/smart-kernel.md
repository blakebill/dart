# Dual-core Smart outbound (Surge-inspired)

## Goal

Implement **connection-level Smart group** behavior in both kernels:

| Capability | GUI today | Kernel Smart |
| --- | --- | --- |
| Pick best node via URL delay | yes | cold-start / recovery only |
| Same-request failover before returning from dial | no | **yes** |
| First-write handshake feedback for the next connection | no | **yes** |
| Soft-fail when dial ≫ historical mean (×1.5) | no | **yes** |
| Exponential penalty + time decay + success wipe | partial | **yes** |
| Per-host sticky + exploration | no | **yes** |
| Top-K weighted pick | no | **yes** |

Forks:

- `D:\WorkFiles\sing-box` → publish as Dart sing-box release
- `D:\WorkFiles\mihomo` → publish as Dart mihomo release

GUI (`singbox-gui`) only **emits** `type: smart` groups and surfaces stats; decision lives in-kernel.

## Upstream-friendly layout (critical)

**Do not edit upstream group logic in place.** Prefer **new files + one-line registration hooks**.

### Shared algorithm (no kernel imports)

Engine lives **in each fork** (keep the two copies algorithmically identical when changing logic):

- `sing-box/protocol/group/smart/engine/`
- `mihomo/adapter/outboundgroup/smartengine/`

**Upstream sync is GitHub Actions** on each fork (`.github/workflows/dart-sync.yml`), not local scripts.

### sing-box adapter (new package only)

```
protocol/group/smart/
  outbound.go      # DialContext / ListenPacket with retry
  register.go
option/smart.go    # SmartOutboundOptions  (or option/group.go append — prefer separate file)
constant/proxy.go  # + TypeSmart = "smart"   ← unavoidable one-line merge zone
include/registry.go # + group.RegisterSmart  ← one-line merge zone
```

### mihomo adapter

```
adapter/outboundgroup/smart.go
adapter/outboundgroup/smartengine/  # copy of shared engine
constant/adapters.go                # + Smart type enum if needed
parser.go                           # case "smart":  ← one-line merge zone
```

### Merge zone policy

| Change type | Strategy |
| --- | --- |
| New files under `protocol/group/smart/` / `smart.go` | zero upstream conflict |
| Shared `engine/` | keep both fork copies algorithmically identical when you change logic |
| Registration one-liners | marked `// dart-smart:register` for easy conflict resolution after merge |
| Touching `urltest.go` | **forbidden** unless emergency |

## Engine responsibilities (pure)

- Member stats: EWMA handshake/dial latency, fail count, penalty score, last success/fail
- `RecordSuccess(tag, rtt)`, `RecordFailure(tag)`, `RecordSoftFail(tag, rtt)`
- `Select(ctx, host, now) → ordered candidates` (sticky host → top-K weighted → explore)
- Penalty: exponential grow, time decay, strong wipe on success
- Soft-fail: `rtt > max(ewma*1.5, ewma+80ms)`
- Host sticky map (bounded LRU)
- Optional: cold URLTest results as initial prior only

## Dial path (both kernels)

```
for candidate in Select(host):
  start = now
  conn, err = member.Dial(...)
  if err != nil:
    RecordFailure; continue
  if NeedHandshake(conn):
    wrap FirstWrite / handshake timer
    return conn
    // The observer records success/failure/soft-fail for the next connection.
    // Never replay a successful application write on another connection.
  else:
    RecordSuccess; return conn
return lastErr
```

UDP: best-effort same ordering; soft-fail may be dial-error only.

## GUI integration (later PR)

1. `converter.js`: build `type: smart` for 🧠 Smart (sing-box) / `type: smart` proxy-group (mihomo)
2. Remove or demote Node `ManagedAutoSelection` for Smart when core supports it
3. Clash API: expose smart stats if needed (`/proxies/🧠 Smart` already shows `now`)
4. Version gate: only emit smart if core version reports capability

## Upstream sync automation

Per-fork GitHub Actions: **Actions → “Sync upstream…” → Run workflow**.

| Fork | Workflow | Upstream |
| --- | --- | --- |
| `blakebill/sing-box` | `dart-sync.yml` | `SagerNet/sing-box` `stable` |
| `blakebill/mihomo` | `dart-sync.yml` | `MetaCubeX/mihomo` `Meta`/`Alpha` |

Each run: merge upstream → verify Dart Smart hooks → `go test` smart packages → build smoke → push fork branch.

Release tags (`vX.Y.Z-dart.N`) still go through the existing GUI `fetch-core` pipeline after a Dart core publish.
## Phased delivery

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **P0** | Shared engine + dial failover (fail only) on both cores | compiles; failover unit tests |
| **P1** | Soft-fail 1.5×, penalty model | stress dial tests |
| **P2** | Per-host sticky + Top-K random | host regression tests |
| **P3** | GUI emits smart; demote JS Smart selector | e2e with Dart app |
| **P4** | Selective background probe (not full urltest) | CPU/network budget OK |

## Non-goals (v1)

- Full Surge bandwidth modeling
- Perfect packet-loss metrics without kernel TCP introspection
- Using other groups as smart members (same restriction as Surge)

## Risk notes

- Dual-core means **two adapters**, one engine — keep engine free of `C.Proxy` / `adapter.Outbound`
- Windows + TUN: ensure failed dial path does not leak half-open sockets
- First-write failures cannot be transparently retried after DialContext returns;
  replaying application bytes may duplicate a request. They affect subsequent selection.
- Multiplex / connection reuse: soft-fail must not break pooled conns incorrectly
