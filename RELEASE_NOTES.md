# V1.0 Release Notes

Base: deployed and accepted `TENCENT_MINUTE_V1.0_CANDIDATE`.

Production promotion changes only:

1. `volume_normalized` uses integer base units via `Math.round(raw * multiplier)`.
2. Volume audit recognizes lunch/post-close frozen quote snapshots (`SESSION_FROZEN_MATCH`).
3. Formal release metadata enabled.
4. EXACT_5M hard gate can return `formal_trigger_allowed=true` only when all validated conditions pass.
5. A pending `SYNC_SETTLING` bar explicitly blocks the formal trigger.
6. Added explicit `exact_5m_trigger_eligible` field.

No redesign of the verified Tencent fetch, parsing, bar aggregation, auction-seed, gap classification, 5s close grace, 30s sync grace, or completed-only cross-check logic.
