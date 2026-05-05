# OAuth Keepalive Runtime Architecture Report

Date: 2026-05-05
Repo: `wsli`

## Scope

Document keepalive reliability logic for OAuth session maintenance, including refresh strategy, retries, process ownership, and runtime verification.

## Backend Endpoints Used

Keepalive does not use trading GraphQL mutations. It uses OAuth/session endpoints:

- `GET /v1/oauth/v2/token/info`
  - probe token status and expiry metadata
- `POST /v1/oauth/v2/token`
  - refresh token flow (`grant_type: refresh_token`)
- `GET /api/sessions` (best effort)
  - session idle metadata when available

## Runtime Logic

1. Single-instance ownership via PID lock file.
2. Probe token health each cycle.
3. Refresh proactively near expiry threshold.
4. Escalate to forced refresh on repeated auth probe failures.
5. Verify refresh rollover using token metadata/fingerprint evidence.
6. Apply jittered retry backoff for probe/refresh failures.
7. Adapt cadence for active/idle/near-expiry conditions.

## Reliability Changes Applied

- duplicate-loop prevention via PID semantics
- proactive refresh strategy (not only refresh-on-failure)
- retry + jitter for both probe and refresh paths
- resilient handling when session endpoint is unavailable (`404`)
- structured logs for each cycle and retry state

## Validation

- `./wsli ping` reported healthy runtime.
- forced refresh cycles succeeded with rollover verification.
- keepalive continued safely even when session endpoint returned `404`.

## Conclusion

Keepalive now behaves as a proactive, failure-tolerant OAuth maintenance loop with explicit runtime observability and safer multi-process behavior.
