# Tencent Minute MCP Test 0.2 RC2

基于 RC1 实盘/历史回测结果继续收敛的候选测试版。目标是降低剩余生产化风险，但仍然只用于测试，不直接作为 BSI-SWING_V3 正式触发源。

## RC2 相比 RC1 的新增优化

1. **嵌入 2026 年沪深交易所官方休市日历**
   - 周末自动 `NON_TRADING_DAY`
   - 2026 官方休市日自动 `NON_TRADING_DAY`
   - 2026 年以外返回 `CALENDAR_UNVERIFIED`，不猜测，保持 fail-closed
   - 来源：上交所/深交所 2026 年部分节假日休市安排通知（2025-12-22）

2. **请求窗口容量显式化**
   - 1m：可靠输出上限 60 根 completed
   - 5m：可靠输出上限 60 根 completed
   - 15m：保守可靠输出上限 20 根 completed
   - 超出时不静默伪装完整，而在 `request_window` 中明确给出 `requested_limit_supported=false`、`effective_limit` 和说明

3. **新增 volume 只读诊断，不升级单位语义**
   - `volume_validation` 比较当日 1m `volume_raw` 累计与 quote `volume_lot`
   - 仅作为同尺度/快照一致性证据
   - `unit_conclusion` 仍固定为 `UNVERIFIED_TENCENT_RAW`
   - `use_for_formal_gate=false`

4. **修正 window-edge 分类的潜在漏检**
   - 只有“所有缺失分钟都位于请求窗口起点之前”才算 `WINDOW_EDGE_PARTIAL`
   - 如果同一个桶同时存在窗口边缘缺失和窗口内部缺失，内部缺失仍会被识别为 `TRUE_BAR_GAP`

5. **浮点数机器误差不再降低 exact_match**
   - 类似 `30997.03` vs `30997.030000000002` 不再被当成非精确匹配
   - 正式容差标准不放宽，只处理机器浮点尾差

6. **health 增强**
   - 1m 一次取 280 行，尽量覆盖完整当日，用于 volume 诊断
   - quote 放到分钟数据之后取，降低诊断快照错位
   - 输出 `calendar_gate` 和 `volume_validation`

## RC1 已保留的核心规则

- 仅正式测试 1 / 5 / 15 分钟；30 / 60 不开放为正式候选
- 腾讯标签按 BAR_END；结束后约 5 秒进入 completed
- 09:30 为集合竞价/开盘 seed；上午第一根 5m/15m 纳入 seed
- 11:30 上午结束，13:01 下午重新分桶
- `FORMING_PARTIAL / WINDOW_EDGE_PARTIAL / TRUE_BAR_GAP` 三分法
- cross-check 只比较双方 completed bar
- 真正 completed 路径冲突 fail-closed
- BSE quote 正常但 mkline 无行时返回 `UNSUPPORTED_UNVERIFIED_BSE_MINUTE`
- 易歧义指数要求显式前缀，例如 `sh000300`

## 工具兼容性

RC2 **不修改现有主工具名称，并兼容旧工具快照的 interval 枚举**：

- `get_tencent_minute_kline`
- `tencent_minute_health`

如果旧 ChatGPT 工具快照仍允许 30/60，RC2 会结构化返回 `UNSUPPORTED_INTERVAL`，而不是协议报错或静默返回不完整历史；正式候选仍只有 1/5/15。

服务器中仍保留 `tencent_minute_logic_selftest`。如果 ChatGPT Draft App 的工具快照没有暴露它，不影响主工具回测；无需为了 RC2 强制重建 App。

## 安全状态

- `safety_status=TEST_ONLY`
- `formal_v3_trigger=NOT_APPROVED`
- `formal_trigger_allowed=false`
- `volume_raw=UNVERIFIED_TENCENT_RAW`
- volume 诊断不参与正式交易 gate

## 官方日历来源

- SSE: https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
- SZSE: https://www.szse.cn/disclosure/notice/general/t20251222_618087.html

2027 年及以后需要更新官方休市日历后才能解除 `CALENDAR_UNVERIFIED`。
