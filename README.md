# Tencent Minute MCP V1.0 Candidate

Server version: `TENCENT_MINUTE_V1.0_CANDIDATE`

This package is the deployment candidate built from RC3. It is intentionally **fail-closed** for BSI-SWING_V3 formal triggers until the acceptance regression passes.

## What changed from RC3

- Keeps the verified BAR_END model: 5s bar-close grace and 30s native-vs-1m sync grace.
- Keeps 09:30 auction seed handling, lunch/PM session boundaries, window-edge vs true-gap classification, and completed-only cross verification.
- Adds **board/family-aware volume normalization**:
  - STAR `sh688xxx`: raw volume treated as shares, multiplier x1.
  - Empirically validated SSE/SZSE A-share families: raw volume treated as lots, multiplier x100 shares.
  - Empirically validated ETFs `sh5xxxxx` / `sz1xxxxx`: raw volume treated as lots, multiplier x100 fund units.
  - Index/BSE/unknown families: absolute normalization remains fail-closed; same-symbol relative-volume ratios may still be used where marked.
- Renames the quote cumulative volume field to `volume_raw_quote` to avoid the misleading universal `volume_lot` name.
- Adds `volume_profile`, `volume_normalized`, and `volume_normalized_unit` to returned bars where absolute normalization is validated.
- Adds `v3_candidate_gate` for EXACT_5M. The data gate can pass, but `formal_trigger_allowed` stays `false` in this candidate.

## Important volume note

The unit rules are **empirical**, not official Tencent API documentation. They were validated with live Tencent minute data plus independent turnover-amount reconstruction on representative symbols. V1.0 therefore labels the rules `EMPIRICALLY_VALIDATED_FAMILY_RULE_V1` and fails closed outside validated families.

## Supported intervals

Formal validation scope: `1m`, `5m`, `15m`.

`30m` and `60m` are accepted only for compatibility with older ChatGPT tool snapshots and return `UNSUPPORTED_INTERVAL`.

## Deployment

Replace the existing GitHub project with this package and let Cloudflare redeploy the same Worker. The Worker name remains `tencent-minute-mcp-test`, so the MCP URL does not need to change.

After deployment, call `tencent_minute_health` and confirm:

- `version = TENCENT_MINUTE_V1.0_CANDIDATE`
- `safety_status = RELEASE_CANDIDATE_TEST_ONLY`
- `release_status = V1_0_CANDIDATE_PENDING_ACCEPTANCE`
- `formal_v3_trigger = NOT_APPROVED`

Then run the acceptance tests in `ACCEPTANCE_TESTS.md`.
