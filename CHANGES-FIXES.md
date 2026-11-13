# Fixes applied to Housiy-v10-UNIFIED-ROOM-EMAIL-MASK

No UI, markup, CSS, API or protocol changes. Behaviour with a healthy WebSocket is identical.

## Runtime
- `src/assets/js/common.js`
  - **Reconnect backoff bypass fixed.** `rtMaybeConnectSocket()` (called after every poll response) no longer calls `connect()` while a backoff timer is pending, so `/ws` is no longer hit every poll during a gateway outage.
  - Backoff cap lowered 30s -> 10s so the socket returns within ~10s of a gateway restart (handshake failures are served by nginx only, no PHP load).
  - **Outage poll ramp.** Fallback polling starts at `FALLBACK_POLL_MS` (1.5s) and relaxes to every 3s after 20s of outage (never slower than the fastest auto-call pace; less PHP-FPM pressure with many players).
  - **Every missed number is announced.** New `speakMissedNumbers()`: when a snapshot (HTTP fallback poll, reconnect, sequence-gap recovery) contains several numbers the page had not seen, each is spoken in call order (missed ones slightly faster so the voice catches up, newest at normal pace; capped at the last 6). Used by `page-player.js` and `page-host.js` snapshot paths only. Live WebSocket events still use `speakNumber()` per event, exactly as before.
  - **Stall watchdog.** While a game is auto-calling and the socket is connected but silent for 20s (worker down / lost publish), one canonical snapshot is fetched. Uses the HELLO heartbeat value that was previously unused.
- `realtime/server.js`: per-connection `ROOM CODE ACCEPTED` / `INVALID ROOM CODE DEBUG` logs only when `WS_DEBUG=1` (rejections are still logged by `reject()`); header comment corrected. `docker-compose.yml` passes `WS_DEBUG` (default 0).
- `realtime/server.js` (logging): every `[WS AUTH]` / `[WS AUTH TIMING]` line now carries an ISO timestamp, and the timing line includes `room=`, so each (re)connect can be timed exactly from `docker compose logs realtime`.
- `src/includes/RateLimiter.php`: one-time error_log when `RATE_LIMIT_HASH_SALT` is unset / `CHANGE_ME` outside dev (behaviour unchanged). `envctl.sh validate` already rejects placeholders.
- `bootstrap.min.css`: removed the `sourceMappingURL` comment (stops the 404 for the .map file).
- `Container Diagnostics.txt`: gateway health URL `/health` -> `/healthz`.

## Tests
- `winner-notification-contract.test.js`: stale regex updated (server masks via `mask_room_public_people()`).
- `speech-unlock-contract.test.js`: path now relative to the file, so it runs from any directory; added to `npm test`.
- `client.test.js`: new regression tests for backoff bypass and the stall watchdog.
- `missed-numbers-contract.test.js` (new, in `npm test`): verifies all missed numbers are spoken in order, the cap, and the single-number case.

## Deliberately NOT changed (would alter behaviour/UI)
- ACK_EVENT (covered by an existing test), CSP `connect-src` host, name-based blocking, HTTP 400 for blocked login, rematch modal opacity, `TRUSTED_PROXIES` values (deployment specific; `envctl.sh` warns).
- `tests/frontend/*` jsdom tests already failed before these changes (stale vs current UI); untouched.

## Multiple Full House winners (1–5)

- **Create Room:** a number box next to the *Full House* checkbox sets how many players can win Full House (1–5, default 1, disabled while Full House is unticked). With 1 everything behaves exactly as before.
- **Claim button:** with more than one winner the button reads `Full House (n)` where n is the winners still to come. A player who has won sees their own button turn green and close; everyone else keeps claiming until n reaches 0. The same player cannot win Full House twice.
- **Game flow:** the game continues until every enabled prize is won and every Full House slot is filled. Slots are capped at the number of players in the room, so a game can never wait for winners who cannot exist. Prize order is unchanged (all other prizes before Full House).
- **Announcements:** each Full House winner gets the drop-down alert and voice ("Full House, 2nd winner"), queued one after another; number calling is paused around each one (see the winner pause above). Winners lists and the final card number the winners (1st, 2nd, …).
- **Admin:** room details, PDF and Excel reports list every Full House winner as `FULL HOUSE #n of N`.
- **Rematch** keeps the same winner count.
- **Database:** fresh installs only. `sql/schema.sql` includes the new `rooms.full_house_winners` and `room_prize_winners.winner_position` columns; there is no migration, so import the complete schema into a new database.
