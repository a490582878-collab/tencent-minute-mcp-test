# Tencent Minute MCP Test 0.1

独立的腾讯分钟K测试项目，不修改现有腾讯A股行情V1.1。

## 工具

- `tencent_minute_health`
- `get_tencent_minute_kline`

## 支持周期

1 / 5 / 15 / 30 / 60 分钟。

## 安全约束

- 当前 `formal_v3_trigger=NOT_APPROVED`。
- 不把原始第7/8字段解释为成交额。
- `volume_raw` 单位暂不在测试版中下最终定义。
- 盘中 completed/forming 使用保守规则，直到边界测试确认腾讯时间标签语义。
- 5分钟以上先用1分钟本地聚合，再串行请求腾讯原生周期做逐根比较。

## 部署

建议新建独立 GitHub 仓库：`tencent-minute-mcp-test`。
Cloudflare Worker 部署后，MCP URL 为：

`https://<你的worker>.workers.dev/mcp`

ChatGPT 建议创建 Draft App：`腾讯分钟K测试`，测试通过前不要发布用于正式交易。
