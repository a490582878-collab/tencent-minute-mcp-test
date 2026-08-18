# V1.0 Candidate acceptance tests

Run in this order. The first six can be done immediately; the boundary tests need a live trading window.

1. `tencent_minute_logic_selftest`
   - expected: `ok=true`, all cases PASS.

2. `tencent_minute_health`
   - expected: version `TENCENT_MINUTE_V1.0_CANDIDATE`.
   - `minute_5m` should be Grade-A ready or sync-settling, not path conflict.
   - `true_gap_count=0` for healthy live data.

3. Volume family regression
   - `sh688981`, 5m: `volume_profile.raw_unit=SHARE`, multiplier=1.
   - `sh688256`, 5m: same as above.
   - `300059`, 5m: `LOT_100_SHARES`, multiplier=100.
   - `601066`, 5m: `LOT_100_SHARES`, multiplier=100.
   - `sh510300` and `sz159919`, 5m: `LOT_100_UNITS`, multiplier=100.
   - `sh000300`, 5m: absolute normalization must remain fail-closed.

4. Cross-path regression
   - representative 5m calls should show `cross_path_check.status=PASS` on verification-eligible completed bars.
   - one-unit volume difference may be within tolerance but must be visible as non-exact.

5. Fail-closed regression
   - `000300` without prefix must be rejected as ambiguous.
   - BSE path must not receive formal eligibility.
   - 30m/60m must return `UNSUPPORTED_INTERVAL`.

6. V3 data gate regression
   - healthy 5m Grade-A call: `v3_candidate_gate.data_gate_pass=true` with an `eligible_bar_time`.
   - server-level `formal_trigger_allowed` must still be false in Candidate.

7. Live boundary regression (one trading day, short)
   - ordinary 5m boundary: before +5s = forming; +5s to +30s = settling; after +30s = eligible for cross verification.
   - first PM 5m at/after 13:05: source rows must be 13:01-13:05 only.
   - around close: no phantom post-close minutes and the 15:00 bucket must settle/verify correctly.

Release rule: all acceptance items PASS -> generate/promote `TENCENT_MINUTE_V1.0` formal package -> only then integrate into 学委 and BSI-SWING_V3.
