import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const VERSION = "TENCENT_MINUTE_TEST_0.1";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALLOWED_INTERVALS = [1, 5, 15, 30, 60] as const;
type Interval = (typeof ALLOWED_INTERVALS)[number];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(input: string): string {
  const raw = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(raw)) return raw;
  if (!/^\d{6}$/.test(raw)) throw new Error(`股票代码格式不正确: ${input}`);
  if (/^[56]/.test(raw)) return `sh${raw}`;
  if (/^[0123]/.test(raw)) return `sz${raw}`;
  if (/^[489]/.test(raw)) return `bj${raw}`;
  throw new Error(`无法可靠判断交易所: ${input}，请显式写 sh/sz/bj 前缀`);
}

function beijingNowParts(date = new Date()) {
  const bj = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const year = bj.getUTCFullYear();
  const month = bj.getUTCMonth() + 1;
  const day = bj.getUTCDate();
  const hour = bj.getUTCHours();
  const minute = bj.getUTCMinutes();
  const second = bj.getUTCSeconds();
  return {
    year, month, day, hour, minute, second,
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    time: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    iso: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`,
    hhmmss: hour * 10000 + minute * 100 + second,
    totalMinutes: hour * 60 + minute
  };
}

function beijingEpochMs(year: number, month: number, day: number, hour: number, minute: number, second = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

function parseMinuteTime(raw: unknown) {
  const s = String(raw ?? "").trim();
  let y: number, mo: number, d: number, h: number, mi: number, sec = 0;

  let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
    h = Number(m[4]); mi = Number(m[5]); sec = m[6] ? Number(m[6]) : 0;
  } else {
    m = s.match(/^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
    h = Number(m[4]); mi = Number(m[5]); sec = m[6] ? Number(m[6]) : 0;
  }

  const date = `${y}-${pad2(mo)}-${pad2(d)}`;
  const time = `${pad2(h)}:${pad2(mi)}`;
  return {
    raw: s,
    year: y, month: mo, day: d, hour: h, minute: mi, second: sec,
    date,
    time,
    normalized: `${date} ${time}`,
    iso: `${date}T${time}:${pad2(sec)}+08:00`,
    epochMs: beijingEpochMs(y, mo, d, h, mi, sec),
    totalMinutes: h * 60 + mi
  };
}

function isTradingMinute(totalMinutes: number) {
  return (totalMinutes >= 9 * 60 + 31 && totalMinutes <= 11 * 60 + 30) ||
    (totalMinutes >= 13 * 60 + 1 && totalMinutes <= 15 * 60);
}

function isDefinitelyCompleteConservative(parsedTime: ReturnType<typeof parseMinuteTime>, interval: Interval, now = new Date()) {
  if (!parsedTime) return false;
  const bj = beijingNowParts(now);
  if (parsedTime.date < bj.date) return true;
  if (parsedTime.date > bj.date) return false;

  // 收盘后给5分钟缓冲：当天15:00及以前的分钟K均可视为完成。
  if (bj.hhmmss >= 150500) return parsedTime.totalMinutes <= 15 * 60;

  // 午休期间，11:30及以前的K线视为完成。
  if (bj.totalMinutes >= 11 * 60 + 30 && bj.totalMinutes < 13 * 60) {
    return parsedTime.totalMinutes <= 11 * 60 + 30;
  }

  // 盘中时间戳语义尚未实测确认。按“标签可能是bar开始时间”的最保守解释，
  // 只有当前时间超过标签 + interval + 5秒才进入completed_bars。
  return now.getTime() >= parsedTime.epochMs + interval * 60_000 + 5_000;
}

type RawMinuteBar = {
  time: string;
  raw_time: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume_raw: number | null;
  raw_extra_1: string | null;
  raw_extra_2: string | null;
  is_complete_conservative: boolean;
};

function parseMinuteRows(rows: unknown[], interval: Interval, now = new Date()): RawMinuteBar[] {
  return rows
    .filter((r): r is unknown[] => Array.isArray(r) && r.length >= 6)
    .map((r) => {
      const pt = parseMinuteTime(r[0]);
      return {
        time: pt?.normalized ?? String(r[0]),
        raw_time: String(r[0]),
        open: num(r[1]),
        close: num(r[2]),
        high: num(r[3]),
        low: num(r[4]),
        volume_raw: num(r[5]),
        raw_extra_1: r.length > 6 && r[6] != null ? String(r[6]) : null,
        raw_extra_2: r.length > 7 && r[7] != null ? String(r[7]) : null,
        is_complete_conservative: isDefinitelyCompleteConservative(pt, interval, now)
      };
    });
}

function integrityCheck(bars: RawMinuteBar[]) {
  const issues: string[] = [];
  for (const b of bars) {
    if ([b.open, b.close, b.high, b.low].some((x) => x == null)) {
      issues.push(`${b.time}: OHLC_NULL`);
      continue;
    }
    const open = b.open as number, close = b.close as number, high = b.high as number, low = b.low as number;
    if (high < low) issues.push(`${b.time}: HIGH_LT_LOW`);
    if (high < Math.max(open, close)) issues.push(`${b.time}: HIGH_LT_OPEN_CLOSE`);
    if (low > Math.min(open, close)) issues.push(`${b.time}: LOW_GT_OPEN_CLOSE`);
    if (b.volume_raw != null && b.volume_raw < 0) issues.push(`${b.time}: NEGATIVE_VOLUME`);
  }
  return { ok: issues.length === 0, issues: issues.slice(0, 50) };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonOnce(url: string, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://gu.qq.com/",
        "Accept": "application/json,text/plain,*/*"
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const trimmed = text.trim();
    const jsonText = trimmed.startsWith("{")
      ? trimmed
      : trimmed.includes("=")
        ? trimmed.slice(trimmed.indexOf("=") + 1).replace(/;\s*$/, "")
        : trimmed;
    return JSON.parse(jsonText);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTencentMinuteRaw(symbol: string, interval: Interval, limit: number) {
  const key = `m${interval}`;
  const count = Math.max(5, Math.min(320, limit));
  const hosts = ["ifzq.gtimg.cn", "web.ifzq.gtimg.cn"];
  const errors: string[] = [];
  let attempts = 0;

  for (const host of hosts) {
    const url = `https://${host}/appstock/app/kline/mkline?param=${encodeURIComponent(`${symbol},${key},,${count}`)}`;
    for (let i = 0; i < 3; i++) {
      attempts++;
      try {
        const obj: any = await fetchJsonOnce(url);
        if (obj?.code !== 0) throw new Error(`Tencent code=${obj?.code} msg=${obj?.msg ?? ""}`);
        const block = obj?.data?.[symbol];
        const rows = block?.[key];
        if (!Array.isArray(rows) || rows.length === 0) throw new Error(`NO_${key}_ROWS`);
        return {
          ok: true as const,
          rows,
          qt: block?.qt?.[symbol] ?? null,
          fetch_meta: { source_url: url, host, attempts, errors }
        };
      } catch (e) {
        errors.push(`${host}#${i + 1}: ${String(e)}`);
        if (i < 2) await sleep(180 + i * 250);
      }
    }
  }

  return {
    ok: false as const,
    rows: [] as unknown[],
    qt: null,
    fetch_meta: { source_url: null, host: null, attempts, errors },
    error: "Tencent minute request failed on all live paths"
  };
}

function bucketEndLabel(pt: NonNullable<ReturnType<typeof parseMinuteTime>>, interval: Interval) {
  if (interval === 1) return pt.normalized;
  let sessionStart: number;
  if (pt.totalMinutes >= 9 * 60 + 31 && pt.totalMinutes <= 11 * 60 + 30) {
    sessionStart = 9 * 60 + 30;
  } else if (pt.totalMinutes >= 13 * 60 + 1 && pt.totalMinutes <= 15 * 60) {
    sessionStart = 13 * 60;
  } else {
    return null;
  }
  const idx = pt.totalMinutes - sessionStart; // 09:31 => 1
  const bucketEnd = Math.ceil(idx / interval) * interval + sessionStart;
  const h = Math.floor(bucketEnd / 60);
  const m = bucketEnd % 60;
  return `${pt.date} ${pad2(h)}:${pad2(m)}`;
}

type AggregatedBar = {
  time: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume_raw: number | null;
  source_rows: number;
  expected_rows: number;
  is_complete: boolean;
  source_times: string[];
};

function aggregate1mBars(raw1m: RawMinuteBar[], interval: Interval): { bars: AggregatedBar[]; gap_bars: string[] } {
  if (interval === 1) {
    return {
      bars: raw1m.map((b) => ({
        time: b.time, open: b.open, close: b.close, high: b.high, low: b.low,
        volume_raw: b.volume_raw, source_rows: 1, expected_rows: 1,
        is_complete: b.is_complete_conservative, source_times: [b.time]
      })),
      gap_bars: []
    };
  }

  const groups = new Map<string, RawMinuteBar[]>();
  for (const b of raw1m) {
    const pt = parseMinuteTime(b.time);
    if (!pt || !isTradingMinute(pt.totalMinutes)) continue;
    const label = bucketEndLabel(pt, interval);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(b);
  }

  const bars: AggregatedBar[] = [];
  const gapBars: string[] = [];
  const labels = [...groups.keys()].sort();

  for (const label of labels) {
    const rows = groups.get(label)!.sort((a, b) => a.time.localeCompare(b.time));
    const completeRows = rows.filter((r) => r.is_complete_conservative);
    const expected = interval;
    const enoughRows = rows.length === expected;
    if (!enoughRows) gapBars.push(`${label}: ${rows.length}/${expected}`);

    const highs = rows.map((x) => x.high).filter((x): x is number => x != null);
    const lows = rows.map((x) => x.low).filter((x): x is number => x != null);
    const volumes = rows.map((x) => x.volume_raw).filter((x): x is number => x != null);

    bars.push({
      time: label,
      open: rows[0]?.open ?? null,
      close: rows[rows.length - 1]?.close ?? null,
      high: highs.length ? Math.max(...highs) : null,
      low: lows.length ? Math.min(...lows) : null,
      volume_raw: volumes.length === rows.length ? volumes.reduce((a, b) => a + b, 0) : null,
      source_rows: rows.length,
      expected_rows: expected,
      is_complete: enoughRows && completeRows.length === expected,
      source_times: rows.map((x) => x.time)
    });
  }

  return { bars, gap_bars: gapBars };
}

function compareBars(nativeBars: RawMinuteBar[], aggregated: AggregatedBar[], maxCompare = 12) {
  const nativeMap = new Map(nativeBars.map((b) => [b.time, b]));
  const aggMap = new Map(aggregated.map((b) => [b.time, b]));
  const common = [...nativeMap.keys()].filter((t) => aggMap.has(t)).sort().slice(-maxCompare);
  const comparisons: any[] = [];
  let mismatchCount = 0;
  let exactMatchCount = 0;

  for (const time of common) {
    const n = nativeMap.get(time)!;
    const a = aggMap.get(time)!;
    const prices = ["open", "close", "high", "low"] as const;
    const priceDiffs: Record<string, number | null> = {};
    let priceOk = true;
    let priceExact = true;
    for (const k of prices) {
      if (n[k] == null || a[k] == null) {
        priceOk = false;
        priceExact = false;
        priceDiffs[k] = null;
      } else {
        const diff = Math.abs((n[k] as number) - (a[k] as number));
        priceDiffs[k] = diff;
        if (diff > 0.005) priceOk = false;
        if (diff !== 0) priceExact = false;
      }
    }

    let volumeOk = false;
    let volumeExact = false;
    let volumeDiff: number | null = null;
    if (n.volume_raw != null && a.volume_raw != null) {
      volumeDiff = Math.abs(n.volume_raw - a.volume_raw);
      const rel = volumeDiff / Math.max(1, Math.abs(n.volume_raw));
      volumeOk = volumeDiff <= 2 || rel <= 0.0005;
      volumeExact = volumeDiff === 0;
    }

    const withinTolerance = priceOk && volumeOk;
    const exact = priceExact && volumeExact;
    if (!withinTolerance) mismatchCount++;
    if (exact) exactMatchCount++;

    comparisons.push({
      time,
      within_tolerance: withinTolerance,
      exact_match: exact,
      price_ok: priceOk,
      volume_ok: volumeOk,
      price_diffs: priceDiffs,
      volume_diff: volumeDiff,
      native: { open: n.open, high: n.high, low: n.low, close: n.close, volume_raw: n.volume_raw },
      aggregated: { open: a.open, high: a.high, low: a.low, close: a.close, volume_raw: a.volume_raw, source_rows: a.source_rows }
    });
  }

  return {
    status: common.length === 0 ? "NO_COMMON_BARS" : mismatchCount === 0 ? "PASS" : "CONFLICT",
    compared_count: common.length,
    exact_match_count: exactMatchCount,
    mismatch_count: mismatchCount,
    full_window_exact_match: common.length > 0 && exactMatchCount === common.length,
    full_window_within_tolerance: common.length > 0 && mismatchCount === 0,
    bars: comparisons
  };
}

async function fetchQuoteForDiagnostics(symbol: string) {
  const url = `https://qt.gtimg.cn/q=${symbol}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const text = new TextDecoder("gbk").decode(bytes);
    const m = text.match(/="(.*)"/);
    if (!m) throw new Error("QUOTE_PARSE_FAIL");
    const f = m[1].split("~");
    return {
      ok: true,
      name: f[1] || null,
      code: f[2] || null,
      price: num(f[3]),
      prev_close: num(f[4]),
      open: num(f[5]),
      quote_time: f[30] || null,
      high: num(f[33]),
      low: num(f[34]),
      volume_lot: num(f[36]),
      turnover_wan: num(f[37])
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function buildMinuteResponse(code: string, interval: Interval, limit: number) {
  const symbol = normalizeSymbol(code);
  const fetchedAt = new Date();
  const fetchedAtBeijing = beijingNowParts(fetchedAt).iso;
  const quote = await fetchQuoteForDiagnostics(symbol);

  if (interval === 1) {
    const raw = await fetchTencentMinuteRaw(symbol, 1, Math.min(320, limit + 5));
    if (!raw.ok) {
      return {
        version: VERSION,
        symbol,
        interval: "1m",
        data_status: "DOWN",
        request_policy: "TENCENT_MKLINE_SERIAL_HOST_RETRY_NO_STALE_CACHE",
        preferred_path: null,
        returned_completed_bars: 0,
        completed_bars: [],
        forming_bar: null,
        raw_tail: [],
        integrity: { ok: false, issues: ["NO_DATA"] },
        fetch_meta: raw.fetch_meta,
        quote_diagnostics: quote,
        fetched_at_beijing: fetchedAtBeijing,
        timestamp_semantics: "UNVERIFIED",
        classification_policy: "CONSERVATIVE_UNTIL_LIVE_BOUNDARY_TESTS_PASS",
        field_semantics: {
          columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
          volume_unit: "UNVERIFIED_TENCENT_RAW",
          raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
          raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT"
        },
        safety_status: "TEST_ONLY",
        formal_v3_trigger: "NOT_APPROVED",
        error: raw.error
      };
    }

    const bars = parseMinuteRows(raw.rows, 1, fetchedAt);
    const completed = bars.filter((b) => b.is_complete_conservative).slice(-limit);
    const incomplete = bars.filter((b) => !b.is_complete_conservative);
    return {
      version: VERSION,
      symbol,
      interval: "1m",
      data_status: "OK",
      request_policy: "TENCENT_MKLINE_SERIAL_HOST_RETRY_NO_STALE_CACHE",
      preferred_path: "TENCENT_NATIVE_1M",
      returned_completed_bars: completed.length,
      completed_bars: completed,
      forming_bar: incomplete.length ? incomplete[incomplete.length - 1] : null,
      raw_tail: bars.slice(-5),
      integrity: integrityCheck(bars),
      fetch_meta: raw.fetch_meta,
      quote_diagnostics: quote,
      fetched_at_beijing: fetchedAtBeijing,
      timestamp_semantics: "UNVERIFIED",
      classification_policy: "CONSERVATIVE_UNTIL_LIVE_BOUNDARY_TESTS_PASS",
      field_semantics: {
        columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
        volume_unit: "UNVERIFIED_TENCENT_RAW",
        raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
        raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT"
      },
      safety_status: "TEST_ONLY",
      formal_v3_trigger: "NOT_APPROVED",
      error: null
    };
  }

  // 对5/15/30/60分钟：先拉1分钟做本地聚合，再串行拉原生周期做验证。
  const oneMinNeed = Math.min(320, Math.max(80, interval * (limit + 3)));
  const one = await fetchTencentMinuteRaw(symbol, 1, oneMinNeed);
  if (one.ok) await sleep(220);
  const native = await fetchTencentMinuteRaw(symbol, interval, Math.min(320, limit + 8));

  let oneBars: RawMinuteBar[] = [];
  let aggregated: AggregatedBar[] = [];
  let gapBars: string[] = [];
  if (one.ok) {
    oneBars = parseMinuteRows(one.rows, 1, fetchedAt);
    const agg = aggregate1mBars(oneBars, interval);
    aggregated = agg.bars;
    gapBars = agg.gap_bars;
  }

  let nativeBars: RawMinuteBar[] = [];
  if (native.ok) nativeBars = parseMinuteRows(native.rows, interval, fetchedAt);

  const aggCompleted = aggregated.filter((b) => b.is_complete).slice(-limit);
  const aggIncomplete = aggregated.filter((b) => !b.is_complete);
  const nativeCompleted = nativeBars.filter((b) => b.is_complete_conservative).slice(-limit);
  const nativeIncomplete = nativeBars.filter((b) => !b.is_complete_conservative);
  const cross = one.ok && native.ok ? compareBars(nativeBars, aggregated, Math.min(12, limit)) : {
    status: "NOT_AVAILABLE",
    compared_count: 0,
    exact_match_count: 0,
    mismatch_count: 0,
    full_window_exact_match: false,
    full_window_within_tolerance: false,
    bars: []
  };

  const aggOk = one.ok && aggCompleted.length > 0;
  const nativeOk = native.ok && nativeCompleted.length > 0;
  let dataStatus = "DOWN";
  let preferredPath: string | null = null;
  if (aggOk && nativeOk && cross.status === "PASS") {
    dataStatus = "OK";
    preferredPath = "AGGREGATED_FROM_TENCENT_1M_VERIFIED_BY_TENCENT_NATIVE";
  } else if (aggOk && nativeOk && cross.status === "CONFLICT") {
    dataStatus = "DEGRADED_PATH_CONFLICT";
    preferredPath = null;
  } else if (aggOk) {
    dataStatus = "DEGRADED_AGGREGATED_ONLY";
    preferredPath = "AGGREGATED_FROM_TENCENT_1M_ONLY";
  } else if (nativeOk) {
    dataStatus = "DEGRADED_NATIVE_ONLY";
    preferredPath = "TENCENT_NATIVE_ONLY";
  }

  return {
    version: VERSION,
    symbol,
    interval: `${interval}m`,
    data_status: dataStatus,
    request_policy: "SEQUENTIAL_TENCENT_1M_PRIMARY_THEN_NATIVE_VERIFY",
    preferred_path: preferredPath,
    returned_completed_bars: preferredPath?.startsWith("AGGREGATED") ? aggCompleted.length : nativeCompleted.length,
    completed_bars: preferredPath?.startsWith("AGGREGATED") ? aggCompleted : nativeCompleted,
    forming_bar: preferredPath?.startsWith("AGGREGATED")
      ? (aggIncomplete.length ? aggIncomplete[aggIncomplete.length - 1] : null)
      : (nativeIncomplete.length ? nativeIncomplete[nativeIncomplete.length - 1] : null),
    aggregated_from_1m_path: {
      status: aggOk ? "OK" : one.ok ? "NO_COMPLETE_AGGREGATED_BARS" : "DOWN",
      completed_bars: aggCompleted,
      forming_bar: aggIncomplete.length ? aggIncomplete[aggIncomplete.length - 1] : null,
      gap_bars: gapBars,
      source_1m_integrity: one.ok ? integrityCheck(oneBars) : { ok: false, issues: ["NO_1M_DATA"] },
      fetch_meta: one.fetch_meta,
      error: one.ok ? null : one.error,
      aggregation_assumption: "TENCENT_1M_LABEL_IS_MINUTE_END; VALIDATE_WITH_NATIVE_WINDOW_COMPARISON"
    },
    native_path: {
      status: nativeOk ? "OK" : native.ok ? "NO_COMPLETE_NATIVE_BARS" : "DOWN",
      completed_bars: nativeCompleted,
      forming_bar: nativeIncomplete.length ? nativeIncomplete[nativeIncomplete.length - 1] : null,
      raw_tail: nativeBars.slice(-5),
      integrity: native.ok ? integrityCheck(nativeBars) : { ok: false, issues: ["NO_NATIVE_DATA"] },
      fetch_meta: native.fetch_meta,
      error: native.ok ? null : native.error
    },
    cross_path_check: cross,
    quote_diagnostics: quote,
    fetched_at_beijing: fetchedAtBeijing,
    timestamp_semantics: "UNVERIFIED; NATIVE_LABEL_MAY_BE_BAR_END; AGGREGATION_ASSUMES_1M_LABEL_IS_MINUTE_END",
    classification_policy: "CONSERVATIVE_UNTIL_LIVE_BOUNDARY_TESTS_PASS",
    field_semantics: {
      native_columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
      volume_unit: "UNVERIFIED_TENCENT_RAW",
      raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
      raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
      amount_yuan: "NOT_PROVIDED_IN_TEST_VERSION"
    },
    safety_status: "TEST_ONLY",
    formal_v3_trigger: "NOT_APPROVED",
    error: dataStatus === "DOWN" ? "Both Tencent minute paths unavailable" : null
  };
}

function createServer() {
  const server = new McpServer({
    name: "Tencent Minute Kline Test",
    version: "0.1.0"
  });

  server.registerTool(
    "get_tencent_minute_kline",
    {
      description:
        "测试腾讯分钟K。支持1/5/15/30/60分钟；5分钟以上会用腾讯1分钟本地聚合并与腾讯原生周期逐根比较。当前仅供测试，禁止直接用于BSI-SWING_V3正式触发。",
      inputSchema: {
        code: z.string().describe("股票代码，例如300059或sz300059"),
        interval: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).default(5),
        limit: z.number().int().min(5).max(60).default(20)
      }
    },
    async ({ code, interval, limit }) => {
      try {
        const data = await buildMinuteResponse(code, interval as Interval, limit);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              version: VERSION,
              data_status: "DOWN",
              safety_status: "TEST_ONLY",
              formal_v3_trigger: "NOT_APPROVED",
              error: String(e)
            }, null, 2)
          }]
        };
      }
    }
  );

  server.registerTool(
    "tencent_minute_health",
    {
      description:
        "腾讯分钟K测试健康检查：依次测试300059的实时quote、1分钟K和5分钟K，并返回结构化状态。",
      inputSchema: {}
    },
    async () => {
      const started = new Date();
      const symbol = "sz300059";
      const quote = await fetchQuoteForDiagnostics(symbol);
      const m1 = await buildMinuteResponse(symbol, 1, 12);
      await sleep(250);
      const m5 = await buildMinuteResponse(symbol, 5, 8);
      const m1Ok = m1.data_status === "OK";
      const m5Usable = ["OK", "DEGRADED_AGGREGATED_ONLY", "DEGRADED_NATIVE_ONLY"].includes(String(m5.data_status));
      const result = {
        version: VERSION,
        ok: Boolean(quote.ok && m1Ok && m5Usable),
        fetched_at_beijing: beijingNowParts(started).iso,
        readiness: {
          quote: quote.ok ? "READY_FOR_TEST" : "DOWN",
          minute_1m: m1Ok ? "READY_FOR_TEST" : "DOWN",
          minute_5m: m5Usable ? "READY_FOR_STABILITY_TEST" : "DOWN",
          formal_v3_trigger: "NOT_APPROVED"
        },
        checks: {
          quote,
          minute_1m: {
            ok: m1Ok,
            data_status: m1.data_status,
            returned_completed_bars: m1.returned_completed_bars,
            forming_bar: m1.forming_bar,
            integrity: m1.integrity,
            fetch_meta: m1.fetch_meta,
            timestamp_semantics: m1.timestamp_semantics,
            error: m1.error
          },
          minute_5m: {
            ok: m5Usable,
            data_status: m5.data_status,
            preferred_path: m5.preferred_path,
            returned_completed_bars: m5.returned_completed_bars,
            forming_bar: m5.forming_bar,
            aggregated_status: m5.aggregated_from_1m_path?.status,
            native_status: m5.native_path?.status,
            gap_bars: m5.aggregated_from_1m_path?.gap_bars,
            cross_path_check: m5.cross_path_check,
            one_minute_fetch_meta: m5.aggregated_from_1m_path?.fetch_meta,
            native_fetch_meta: m5.native_path?.fetch_meta,
            timestamp_semantics: m5.timestamp_semantics,
            error: m5.error
          }
        },
        safety_status: "TEST_ONLY",
        formal_v3_trigger: "NOT_APPROVED"
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return createMcpHandler(createServer)(request, env, ctx);
  }
} satisfies ExportedHandler;
