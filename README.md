# Tencent Minute MCP V1.0

正式版本：`TENCENT_MINUTE_V1.0`

这是由已通过验收的 `V1.0 Candidate` 晋级的正式分钟行情组件。核心分钟解析、1m→5m/15m 聚合、09:30 集合竞价 seed、午休/下午分段、5秒 bar-close、30秒 cross-sync settling、真缺口 fail-closed 和 completed-only 双路径验证均保持原验证逻辑。

## 正式版新增/收口

- `volume_normalized` 统一整数化，避免 `13179601.999999998` 这类 JavaScript 浮点尾差。
- 午休和收盘后的成交量审计识别冻结时段：11:30 午休快照和 15:00 收盘快照可返回 `SESSION_FROZEN_MATCH`。
- 正式启用 EXACT_5M 硬门：
  - 5m
  - 交易日历 PASS
  - `data_grade=A`
  - completed-only `cross_path_check=PASS`
  - `true_bar_gap_count=0`
  - 非未验证 BSE 路径
  - 无待验证 `SYNC_SETTLING`
  - 存在 verified completed 5m bar
- 硬门满足时：`exact_5m_trigger_eligible=true` 且 `formal_trigger_allowed=true`。
- settling、路径冲突、真缺口、Grade B/C、BSE 未验证、非5m等场景继续 fail-closed。

## 成交量口径

当前正式版继续保留实证标签 `EMPIRICALLY_VALIDATED_FAMILY_RULE_V1`：

- 普通沪深A股/创业板：`LOT_100_SHARES` → 标准化为 `SHARE ×100`。
- 科创板 `sh688xxx`：`SHARE ×1`。
- 已验证 ETF：`LOT_100_UNITS` → 标准化为 `FUND_UNIT ×100`。
- 指数：绝对成交量单位仍不宣称，`volume_normalized=null`，但允许同一指数内部相对量能比较。
- 北交所：当前腾讯 mkline 路径仍未验证，正式硬门拒绝。

这些单位规则来自实证交叉验证，不宣称为腾讯官方 API 文档字段定义。

## 周期范围

正式支持：`1m / 5m / 15m`。

`30m / 60m` 仅保留旧 ChatGPT 工具快照兼容输入，返回 `UNSUPPORTED_INTERVAL`。

## 部署

Worker 名称仍保持 `tencent-minute-mcp-test`，工具名不变，因此可以覆盖现有 GitHub 项目并让 Cloudflare 自动重新部署，无需迁移 MCP URL。

部署后不要先改 BSI-SWING_V3。先按 `POST_DEPLOY_SMOKE_TESTS.md` 做一次快速冒烟回归；通过后再接入学委和 V3。
