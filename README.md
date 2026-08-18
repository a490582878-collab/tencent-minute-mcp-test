# Tencent Minute MCP Test 0.2 RC3

Version: `TENCENT_MINUTE_TEST_0.2_RC3`

This is a TEST-ONLY release. It must not be treated as an approved formal BSI-SWING_V3 trigger source.

## Why RC3 exists

RC2 live testing at the 2026-08-17 10:20 five-minute boundary showed that Tencent 1m aggregation can finish before Tencent native 5m has finished synchronizing its final volume. At about +12 seconds, OHLC matched but volume could still differ; by about +21 seconds the two paths matched again.

RC3 keeps the verified BAR_END timestamp model but adds a synchronization-settling layer:

- bar end + 0s to +5s: `FORMING`
- bar end + 5s to +30s: `CLOSED_SETTLING`
- bar end +30s onward: eligible for completed cross-path verification
- only a mismatch that persists after the 30-second sync window may become `PATH_CONFLICT`

This avoids the RC2 false conflict window without returning to a full 5-minute delay.

## Main RC3 changes

1. `BAR_CLOSE_GRACE_MS = 5000`
2. `CROSS_SYNC_GRACE_MS = 30000`
3. New bucket state: `CLOSED_SETTLING`
4. New diagnostics:
   - `FULL_ROWS_SETTLING`
   - `CLOSED_SETTLING_PARTIAL`
   - `closed_settling`
   - `settling_bar`
5. Cross-path comparison scope is now `VERIFICATION_ELIGIBLE_COMPLETED_BARS_ONLY`
6. Bars inside the 30-second sync window are excluded from conflict detection and listed in `settling_excluded_labels`
7. `SYNC_SETTLING` is returned when verified history is healthy but the newest closed bar is still waiting for Tencent path synchronization
8. `formal_candidate_status` returns `WAIT_SYNC_SETTLING` or `WAIT_BAR_CLOSE` when appropriate
9. Persistent mismatch after the sync window still fails closed as `PATH_CONFLICT`

## Existing RC2 safeguards retained

- Formal validated intervals remain 1m / 5m / 15m only
- 30m / 60m remain compatibility-only structured rejections
- 09:30 opening auction seed is included in the first AM 5m/15m bucket
- Lunch and PM session boundaries are separated
- `FORMING_PARTIAL`, `WINDOW_EDGE_PARTIAL`, and `TRUE_BAR_GAP` remain distinct
- BSE minute data remains fail-closed when Tencent returns no rows
- Ambiguous bare index codes such as `000300` are rejected; use `sh000300`
- 2026 SSE/SZSE trading calendar protection remains embedded
- volume semantics remain `UNVERIFIED_TENCENT_RAW`

## Offline validation

RC3 offline logic self-test: `22 / 22 PASS`.

The self-test includes the exact RC2 failure mode:

- +3s full rows -> settling, not gap
- +12s stale native-vs-aggregate mismatch -> excluded from conflict
- +31s persistent mismatch -> conflict
- +31s synchronized values -> verified PASS

## Deployment

Replace the GitHub project files with this package, commit, and let Cloudflare redeploy.

After deployment, confirm the returned version is:

`TENCENT_MINUTE_TEST_0.2_RC3`

Then run one live ordinary 5-minute boundary test. The key expected sequence is:

- just before / just after boundary: forming or full-rows settling
- +5s to +30s: `SYNC_SETTLING`, no `PATH_CONFLICT`
- after +30s: verified `OK` / Grade A if both paths have synchronized

