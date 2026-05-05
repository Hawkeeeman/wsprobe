# Keepalive Behavior Report

Date: 2026-05-05  
Repo: `wsli`  
Scope: `keepalive` reliability, refresh timing, duplicate-process safety, and runtime validation

## Background

Observed production behavior showed token expiry even while keepalive appeared active.  
Investigation confirmed the previous TypeScript keepalive flow primarily refreshed on probe auth failure (`401/403`), rather than proactively before expiry. It also allowed duplicate keeper loops in some scenarios and could terminate on refresh/session probe failures.

## Root Cause Findings

1. Keepalive was probe-first and mostly refresh-on-failure, which is weaker than threshold-driven proactive rotation.
2. Refresh failures (`invalid_grant`) terminated keepalive; once exited, token expiry followed.
3. Concurrent keepalive loops were observed in logs, increasing refresh race/rotation risk.
4. Session idle endpoint behavior differed in this environment (`GET /api/sessions` returned `404`), which initially caused advanced idle probing to fail cycles.

## Implemented Changes

### 1) Single-instance process ownership

- Added PID lock semantics using `~/.config/wsli/keepalive.pid`.
- Prevents duplicate long-running keepalive instances.
- Cleans up PID lock on process exit / SIGINT / SIGTERM.

### 2) Proactive refresh and degraded-path handling

- Keepalive now evaluates token freshness each cycle and refreshes proactively near threshold.
- Added degraded auth handling: repeated auth probe failures escalate to forced refresh path.
- Added optional forced refresh test switch: `WSLI_KEEPALIVE_FORCE_REFRESH=1`.

### 3) Retry + jitter backoff

- Added retry loops for probe and refresh operations.
- Added jittered backoff intervals to reduce correlated retries.

### 4) Refresh verification

- Added rollover verification checks (created/expiry deltas + JWT/fingerprint evidence).
- Refresh cycle fails if no rollover evidence appears after retries.

### 5) Adaptive cadence

- Keeps active/idle cadence selection plus near-expiry acceleration.
- Next-cycle interval is recalculated each cycle and logged.

### 6) Session idle probing resilience

- Session info fetch no longer kills keepalive when endpoint is unavailable in this environment.
- `404` on session endpoint is treated as "session info unavailable", with safe fallback behavior.
- Added explicit telemetry field: `session_info_unavailable`.

## Runtime Validation

### Status check

- `./wsli ping` returned healthy status with active keepalive.

### Forced refresh tests

Executed:

```bash
WSLI_KEEPALIVE_FORCE_REFRESH=1 ./wsli keepalive --once
```

Result:

- `action: "refresh"`
- `expires_in: 1800`
- `refresh_verified: true` in logs
- token fingerprint changed between before/after, confirming rotation
- repeated run also succeeded

### Session endpoint behavior

- Confirmed this environment returns `404` for session endpoint route.
- Verified keepalive now continues successfully (no cycle abort) with fallback.

## Current Behavior Summary

- Keepalive runs as a single owned loop.
- It probes, refreshes proactively, retries with backoff, and verifies rollover.
- It adapts cadence based on token state (and session-idle signal when available).
- It logs structured diagnostics for probe retries, refresh retries, and cycle outcomes.
- It no longer fails hard solely because session-idle endpoint is unavailable.

## Operational Notes

- Test forced refresh:  
  `WSLI_KEEPALIVE_FORCE_REFRESH=1 ./wsli keepalive --once`
- Disable refresh intentionally (diagnostic only):  
  `WSLI_NO_REFRESH=1`
- Health snapshot:  
  `./wsli ping`

## Conclusion

Keepalive now matches wsprobe-grade behavior for proactive token maintenance and reliability controls (excluding browser recovery by design), and it has been validated through repeated forced refresh cycles in the current environment.

