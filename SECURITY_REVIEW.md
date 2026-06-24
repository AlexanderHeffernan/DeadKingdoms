# Security Review Plan

This plan is based on a read-only review of the current game server, client, deployment files, and the desired security posture:

- The Cloudflare Tunnel deployment exposes the game publicly over HTTPS.
- Player sessions should be ephemeral: refreshing or reopening the browser should return to the join screen.
- A player should use one active browser tab/session.
- Live game state should require a valid player or admin session.
- Admin mode should remain simple: type the admin password in-game to toggle admin access.
- Admin roles should be simplified to a single admin capability.
- Clients should be treated as hostile.
- Server protection is more important than preserving a degraded world.
- If TPS remains below 5 for 10 consecutive seconds, the world should terminate safely and log diagnostics.

## Phase 1 — Ephemeral Player Sessions

Goal: stop treating `playerId` as a bearer credential and remove browser reload persistence.

- Generate a random `sessionToken` when `/api/join` creates a player.
- Return `{ playerId, sessionToken }` to the joining browser.
- Keep the session token only in browser memory, not `localStorage`.
- On page load, always show the join/home screen.
- Require `{ playerId, sessionToken }` for player-owned endpoints:
  - `/api/command`
  - `/api/leave`
  - `/api/ping`
  - `/events`
  - `/api/dev/*`
- Allow only the authenticated player session to stream that player's view.
- Treat a valid replacement event stream for the same player/session as replacing the older stream, so admin view changes and short reconnects remain usable.

## Phase 2 — Lock Live World State Behind Sessions

Goal: prevent unauthenticated map-hacking and ID harvesting.

- Remove or restrict unauthenticated `/api/snapshot`.
- Require a valid player session for any live snapshot or event stream.
- Never stream another player's view based only on a query-string `playerId`.
- Keep public endpoints only for non-live information such as status, changelog, and global leaderboard summaries.
- Ensure leaderboard preview snapshots do not reveal current live tactical state.

## Phase 3 — Simplify Admin To One Role

Goal: make admin authorization easy to audit.

- Replace observer/moderator/operator authorization with a single admin capability.
- Keep the current in-game password entry flow.
- Typing the password toggles admin access for the current authenticated player session.
- Require valid player session plus admin access for all dev/admin endpoints.
- Remove or simplify role-specific UI and snapshot behavior.

## Phase 4 — Validate JSON And Command Schemas

Goal: hostile clients should not crash the server with malformed requests.

- Add a bounded JSON body reader with a maximum request size.
- Return `400` for malformed JSON.
- Wrap route handling in top-level `try/catch`.
- Validate each command payload before simulation dispatch.
- Reject unknown command types with own-property checks or a `Map`.
- Validate arrays before calling array methods.
- Validate numeric coordinates with `Number.isFinite`.
- Validate IDs and enum-like values before use.

## Phase 5 — Safe World Dictionaries And ID Access

Goal: prevent prototype pollution and inherited-key confusion.

- Store user-addressable dictionaries as `Object.create(null)` records or `Map`s.
- Add safe accessors for players, units, buildings, resources, ruins, and corpses.
- Require own-property checks for attacker-supplied IDs.
- Reject dangerous keys such as `__proto__`, `prototype`, and `constructor` at API boundaries.

## Phase 6 — Rate Limits And Connection Caps

Goal: protect the Raspberry Pi and game loop from abuse.

- Add app-level limits for joins, commands, logs, admin attempts, and event streams.
- Add one active event stream per player session, with valid same-session replacement allowed.
- Cap request body sizes.
- Use `CF-Connecting-IP` as the preferred client IP when behind Cloudflare Tunnel.
- Add Cloudflare WAF/rate rules for high-risk routes:
  - `/api/join`
  - `/api/command`
  - `/api/dev/*`
  - `/events`
  - `/api/log`

## Phase 7 — Low-TPS World Kill Switch

Goal: protect the host when simulation performance becomes unsafe.

- Track sustained TPS degradation.
- If TPS stays below 5 for 10 consecutive seconds:
  - capture diagnostics: tick, TPS, tick duration, phase timings, player/unit/building/resource/zombie counts, pathing metrics if available, recent notices/admin logs;
  - notify connected players that the world was terminated for server safety;
  - publish/flush leaderboard data if safe;
  - end event streams;
  - clear the current world so players can join a fresh one.
- Add an emergency threshold for extreme single-tick stalls if needed.

## Phase 8 — Security Headers And Browser Hardening

Goal: reduce the impact of future client-side mistakes.

- Add security headers at the app or Cloudflare layer:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy`
  - `Content-Security-Policy`
  - `frame-ancestors 'none'`
  - restrictive `Permissions-Policy`
- Validate dynamic link URLs before inserting into `href` attributes.

## Phase 9 — Deployment Hardening

Goal: limit host impact if the app or a container is attacked.

- Keep running the game as a non-root container user.
- Consider Docker Compose hardening:
  - read-only filesystem where practical;
  - writable `/data` volume only;
  - `no-new-privileges`;
  - dropped capabilities;
  - memory and CPU limits.
- Treat Watchtower's Docker socket mount as host-root equivalent and keep it only as an explicit operational tradeoff.

## Suggested Implementation Order

1. Phase 1: ephemeral sessions and no reload reconnect.
2. Phase 2: lock live state endpoints.
3. Phase 3: single admin role.
4. Phase 4: body limits and command validation.
5. Phase 5: safe dictionaries and ID accessors.
6. Phase 6: rate limits and event stream caps.
7. Phase 7: TPS kill switch and diagnostics.
8. Phase 8: headers and CSP.
9. Phase 9: deployment hardening.
