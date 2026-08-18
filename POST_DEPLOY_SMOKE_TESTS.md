# TENCENT_MINUTE_V1.0 部署后快速回归

部署后按以下顺序检查；不需要等待全天特殊时点。

1. `tencent_minute_logic_selftest`
   - `version=TENCENT_MINUTE_V1.0`
   - `ok=true`
   - `31/31 PASS`

2. `tencent_minute_health`
   - `ok=true`
   - `release_status=V1_0_RELEASED`
   - `true_gap_count=0`
   - completed cross 应为 `PASS`
   - 若当前恰在 sync-settling，`formal_trigger_allowed=false` 属于正确表现；settling结束后健康5m应恢复允许。

3. 代表性5m：
   - `300059`
   - `601066`
   - `sh688981`
   - `sh510300`
   - `sh000300`
   - `bj920118`

4. 核验重点：
   - 普通A股 `volume_normalized` 为整数 SHARE，×100。
   - 科创板 `volume_normalized` 为整数 SHARE，×1。
   - ETF 为整数 FUND_UNIT，×100。
   - 指数绝对volume继续 fail-closed。
   - BSE继续 `UNSUPPORTED_UNVERIFIED_BSE_MINUTE` / Grade C / formal=false。
   - 健康5m Grade A + cross PASS + no true gap + calendar PASS + no settling：`exact_5m_trigger_eligible=true`、`formal_trigger_allowed=true`。
   - 15m 调用的正式5m触发资格必须为 false。
   - 30m/60m 必须结构化拒绝。
   - 裸 `000300` 必须拒绝并要求显式 `sh000300`。

全部 PASS 后：冻结 V1.0 行情代码，开始接入学委和 `BSI-SWING_V3` EXACT_5M 路径。
