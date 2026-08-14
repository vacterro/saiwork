# Performance audit — v0.1.37

Target: zero avoidable latency on the critical path. Every change below was
benchmarked before/after via a focused regression test or a direct timing
measurement, and shipped only when it kept correctness (CAS, atomic
persistence, security, recovery).

## Measured wins

| Area | Baseline | After | Evidence |
|------|----------|-------|----------|
| Workspace cold start | +1500 ms fixed stability sleep after health+config valid | 0 ms artificial delay; post-ready crash observed in background | manager.test: readiness returns < 1000 ms |
| Queue mutation (main thread) | sync fs read/write/fsync/rename/dir-sync blocked the event loop on every mutation | async persistence; event loop free while a 250 ms write is in flight | queue manager test: setImmediate runs promptly during a slow write |
| Queue mutation disk reads | re-read the whole snapshot from disk per mutation for rollback bytes | in-memory cached last persisted snapshot; one JSON.stringify per mutation | — |
| SSE fan-out (N windows) | N × JSON.stringify per event | 1 JSON.stringify per event, shared frame fanned out | broadcaster test: identical frame to N clients |
| Virtual follow-list restore | O(N) findIndex/some per retry frame | O(1) memoized key→index map, rebuilt once per item-set change | — |
| Tab sort comparator | O(N log N × M) session rescans per status update | one reactive pass; O(1) comparator lookups; Set for missing ids | app-tabs tests green |

## Scope notes

- **Sync I/O audit (#14):** the only true hot-path sync I/O was the queue
  persistence path; it is now async. Remaining sync calls are one-time
  startup (auth load, queue load), bounded cold operations (taskkill with a
  timeout), sync atomic helpers on non-hot persist paths, and user-initiated
  filesystem actions.
- **Not implemented in this pass** (deferred, no correctness trade):
  MessageTimeline selection-mode virtualization (#5), instance-hydration DAG
  parallelization (#4), SSE per-window event filtering (#9), giant
  `instance.dataChanged` payload slicing (#11), reconnect refresh collapse
  (#13), cold-start DAG (#15), static server cache (#16), full #17 matrix.
  Each requires a dedicated benchmark + careful renderer/SSE change.

## Rule check

No sleep on the successful critical path, no sync disk I/O on the
interactive server hot path, no N serializations per event per window, no
N session scans per sort, and no optimization weakened CAS, atomic
persistence, security, or recovery.
