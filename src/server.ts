import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const VERSION = "TENCENT_MINUTE_TEST_0.2_RC1";
const MCP_VERSION = "0.2.0";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const COMPLETION_GRACE_MS = 5_000;
const ALLOWED_INTERVALS = [1, 5, 15] as const;
type Interval = (typeof ALLOWED_INTERVALS)[number];

type BarState = "COMPLETED" | "FORMING" | "AUCTION_SEED" | "OUT_OF_SESSION";
type SessionState =
  | "PRE_OPEN"
  | "OPENING_AUCTION"
  | "POST_AUCTION_PRE_CONTINUOUS"
  | "AM_SESSION"
  | "LUNCH_BREAK"
  | "PM_SESSION"
  | "POST_CLOSE";

type PartialKind = "FORMING_PARTIAL" | "WINDOW_EDGE_PARTIAL" | "TRUE_BAR_GAP";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rawExtra(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const AMBIGUOUS_BARE_INDEX_CODES = new Set([
  "000300", // 沪深300（与深市股票代码规则冲突，必须显式写sh000300）
  "000016",
  "000905",
  "000852",
  "000688"
]);

function normalizeSymbol(input: string): string {
  const raw = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(raw)) return raw;
  if (!/^\d{6}$/.test(raw)) throw new Error(`代码格式不正确: ${input}`);

  if (AMBIGUOUS_BARE_INDEX_CODES.has(raw)) {
    throw new Error(`代码 ${raw} 存在指数/证券映射歧义，请显式写交易所前缀，例如 sh${raw}`);
  }

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
    year,
    month,
    day,
    hour,
    minute,
    second,
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
    year: y,
    month: mo,
    day: d,
    hour: h,
    minute: mi,
    second: sec,
    date,
    time,
    normalized: `${date} ${time}`,
    iso: `${date}T${time}:${pad2(sec)}+08:00`,
    epochMs: beijingEpochMs(y, mo, d, h, mi, sec),
    totalMinutes: h * 60 + mi
  };
}

function formatDateTime(date: string, totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${date} ${pad2(h)}:${pad2(m)}`;
}

function sessionStateAt(now = new Date()): SessionState {
  const bj = beijingNowParts(now);
  const t = bj.hhmmss;
  if (t < 91500) return "PRE_OPEN";
  if (t < 92500) return "OPENING_AUCTION";
  if (t < 93000) return "POST_AUCTION_PRE_CONTINUOUS";
  if (t <= 113000) return "AM_SESSION";
  if (t < 130000) return "LUNCH_BREAK";
  if (t <= 150000) return "PM_SESSION";
  return "POST_CLOSE";
}

function isRegularTradingMinute(totalMinutes: number) {
  return (totalMinutes >= 9 * 60 + 31 && totalMinutes <= 11 * 60 + 30) ||
    (totalMinutes >= 13 * 60 + 1 && totalMinutes <= 15 * 60);
}

function isAuctionSeedMinute(totalMinutes: number) {
  return totalMinutes === 9 * 60 + 30;
}

function sourceSession(pt: NonNullable<ReturnType<typeof parseMinuteTime>>) {
  if (pt.totalMinutes >= 9 * 60 + 30 && pt.totalMinutes <= 11 * 60 + 30) return "AM" as const;
  if (pt.totalMinutes >= 13 * 60 + 1 && pt.totalMinutes <= 15 * 60) return "PM" as const;
  return null;
}

function classifyRawMinute(pt: ReturnType<typeof parseMinuteTime>, now = new Date()): BarState {
  if (!pt) return "OUT_OF_SESSION";
  if (isAuctionSeedMinute(pt.totalMinutes)) return "AUCTION_SEED";
  if (!isRegularTradingMinute(pt.totalMinutes)) return "OUT_OF_SESSION";

  const bj = beijingNowParts(now);
  if (pt.date < bj.date) return "COMPLETED";
  if (pt.date > bj.date) return "FORMING";

  return now.getTime() >= pt.epochMs + COMPLETION_GRACE_MS ? "COMPLETED" : "FORMING";
}

function isBucketEndComplete(label: string, now = new Date()) {
  const pt = parseMinuteTime(label);
  if (!pt) return false;
  const bj = beijingNowParts(now);
  if (pt.date < bj.date) return true;
  if (pt.date > bj.date) return false;
  return now.getTime() >= pt.epochMs + COMPLETION_GRACE_MS;
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
  bar_state: BarState;
  is_complete_conservative: boolean;
};

function parseMinuteRows(rows: unknown[], now = new Date()): RawMinuteBar[] {
  return rows
    .filter((r): r is unknown[] => Array.isArray(r) && r.length >= 6)
    .map((r) => {
      const pt = parseMinuteTime(r[0]);
      const state = classifyRawMinute(pt, now);
      return {
        time: pt?.normalized ?? String(r[0]),
        raw_time: String(r[0]),
        open: num(r[1]),
        close: num(r[2]),
        high: num(r[3]),
        low: num(r[4]),
        volume_raw: num(r[5]),
        raw_extra_1: r.length > 6 ? rawExtra(r[6]) : null,
        raw_extra_2: r.length > 7 ? rawExtra(r[7]) : null,
        bar_state: state,
        is_complete_conservative: state === "COMPLETED"
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
    const open = b.open as number;
    const close = b.close as number;
    const high = b.high as number;
    const low = b.low as number;
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
        const fetchedAt = new Date();
        return {
          ok: true as const,
          rows,
          qt: block?.qt?.[symbol] ?? null,
          fetched_at: fetchedAt,
          fetch_meta: {
            source_url: url,
            host,
            attempts,
            errors,
            fetched_at_beijing: beijingNowParts(fetchedAt).iso
          }
        };
      } catch (e) {
        errors.push(`${host}#${i + 1}: ${String(e)}`);
        if (i < 2) await sleep(180 + i * 250);
      }
    }
  }

  const fetchedAt = new Date();
  return {
    ok: false as const,
    rows: [] as unknown[],
    qt: null,
    fetched_at: fetchedAt,
    fetch_meta: {
      source_url: null,
      host: null,
      attempts,
      errors,
      fetched_at_beijing: beijingNowParts(fetchedAt).iso
    },
    error: "Tencent minute request failed on all live paths"
  };
}

function bucketEndLabel(pt: NonNullable<ReturnType<typeof parseMinuteTime>>, interval: Exclude<Interval, 1>) {
  if (isAuctionSeedMinute(pt.totalMinutes)) {
    return formatDateTime(pt.date, 9 * 60 + 30 + interval);
  }

  let sessionStart: number;
  if (pt.totalMinutes >= 9 * 60 + 31 && pt.totalMinutes <= 11 * 60 + 30) {
    sessionStart = 9 * 60 + 30;
  } else if (pt.totalMinutes >= 13 * 60 + 1 && pt.totalMinutes <= 15 * 60) {
    sessionStart = 13 * 60;
  } else {
    return null;
  }

  const idx = pt.totalMinutes - sessionStart;
  const bucketEnd = Math.ceil(idx / interval) * interval + sessionStart;
  return formatDateTime(pt.date, bucketEnd);
}

function expectedSourceTimes(label: string, interval: Exclude<Interval, 1>) {
  const pt = parseMinuteTime(label);
  if (!pt) return [] as string[];

  const firstMorningBucketEnd = 9 * 60 + 30 + interval;
  if (pt.totalMinutes === firstMorningBucketEnd) {
    const out = [formatDateTime(pt.date, 9 * 60 + 30)];
    for (let t = 9 * 60 + 31; t <= firstMorningBucketEnd; t++) out.push(formatDateTime(pt.date, t));
    return out;
  }

  const start = pt.totalMinutes - interval + 1;
  const out: string[] = [];
  for (let t = start; t <= pt.totalMinutes; t++) out.push(formatDateTime(pt.date, t));
  return out;
}

function sessionKeyForTime(label: string) {
  const pt = parseMinuteTime(label);
  if (!pt) return null;
  const session = sourceSession(pt);
  return session ? `${pt.date}:${session}` : null;
}

function generateBucketLabels(raw1m: RawMinuteBar[], interval: Exclude<Interval, 1>) {
  const bySession = new Map<string, number[]>();
  for (const b of raw1m) {
    const pt = parseMinuteTime(b.time);
    if (!pt) continue;
    const session = sourceSession(pt);
    if (!session) continue;
    const label = bucketEndLabel(pt, interval);
    const lp = label ? parseMinuteTime(label) : null;
    if (!label || !lp) continue;
    const key = `${pt.date}:${session}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(lp.totalMinutes);
  }

  const labels: string[] = [];
  for (const [key, mins] of bySession.entries()) {
    if (!mins.length) continue;
    const [date, session] = key.split(":");
    let first = Math.min(...mins);
    const last = Math.max(...mins);
    const legalFirst = session === "AM" ? 9 * 60 + 30 + interval : 13 * 60 + interval;
    first = Math.max(first, legalFirst);
    for (let t = first; t <= last; t += interval) labels.push(formatDateTime(date, t));
  }
  return [...new Set(labels)].sort();
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
  source_times: string[];
  missing_source_times: string[];
  bucket_state: "COMPLETED" | "FORMING" | "WINDOW_EDGE_PARTIAL" | "TRUE_BAR_GAP";
  partial_kind: PartialKind | null;
  is_complete: boolean;
};

type AggregationResult = {
  bars: AggregatedBar[];
  forming_partials: string[];
  window_edge_partials: string[];
  true_bar_gaps: string[];
};

function aggregate1mBars(raw1m: RawMinuteBar[], interval: Exclude<Interval, 1>, now = new Date()): AggregationResult {
  const groups = new Map<string, RawMinuteBar[]>();
  for (const b of raw1m) {
    const pt = parseMinuteTime(b.time);
    if (!pt || (!isRegularTradingMinute(pt.totalMinutes) && !isAuctionSeedMinute(pt.totalMinutes))) continue;
    const label = bucketEndLabel(pt, interval);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(b);
  }

  const earliestBySession = new Map<string, string>();
  for (const b of raw1m) {
    const key = sessionKeyForTime(b.time);
    if (!key) continue;
    const prev = earliestBySession.get(key);
    if (!prev || b.time < prev) earliestBySession.set(key, b.time);
  }

  const bars: AggregatedBar[] = [];
  const formingPartials: string[] = [];
  const windowEdgePartials: string[] = [];
  const trueBarGaps: string[] = [];

  for (const label of generateBucketLabels(raw1m, interval)) {
    const rows = (groups.get(label) ?? []).sort((a, b) => a.time.localeCompare(b.time));
    const expected = expectedSourceTimes(label, interval);
    const rowMap = new Map(rows.map((r) => [r.time, r]));
    const present = expected.filter((t) => rowMap.has(t));
    const missing = expected.filter((t) => !rowMap.has(t));
    const bucketCompleteByClock = isBucketEndComplete(label, now);
    const sessionKey = sessionKeyForTime(label);
    const earliest = sessionKey ? earliestBySession.get(sessionKey) : undefined;
    const missingBeforeWindow = Boolean(earliest && missing.some((t) => t < earliest));

    let bucketState: AggregatedBar["bucket_state"];
    let partialKind: PartialKind | null = null;
    const allExpectedPresent = missing.length === 0;
    const allSourcesReady = present.every((t) => {
      const r = rowMap.get(t)!;
      return r.bar_state === "COMPLETED" || r.bar_state === "AUCTION_SEED";
    });

    if (!bucketCompleteByClock) {
      bucketState = "FORMING";
      partialKind = "FORMING_PARTIAL";
      formingPartials.push(`${label}: ${present.length}/${expected.length}`);
    } else if (!allExpectedPresent && missingBeforeWindow) {
      bucketState = "WINDOW_EDGE_PARTIAL";
      partialKind = "WINDOW_EDGE_PARTIAL";
      windowEdgePartials.push(`${label}: ${present.length}/${expected.length}; missing=${missing.join(",")}`);
    } else if (!allExpectedPresent || !allSourcesReady) {
      bucketState = "TRUE_BAR_GAP";
      partialKind = "TRUE_BAR_GAP";
      trueBarGaps.push(`${label}: ${present.length}/${expected.length}; missing=${missing.join(",")}`);
    } else {
      bucketState = "COMPLETED";
    }

    const orderedRows = present.map((t) => rowMap.get(t)!).filter(Boolean);
    const highs = orderedRows.map((x) => x.high).filter((x): x is number => x != null);
    const lows = orderedRows.map((x) => x.low).filter((x): x is number => x != null);
    const volumes = orderedRows.map((x) => x.volume_raw).filter((x): x is number => x != null);

    bars.push({
      time: label,
      open: orderedRows[0]?.open ?? null,
      close: orderedRows[orderedRows.length - 1]?.close ?? null,
      high: highs.length ? Math.max(...highs) : null,
      low: lows.length ? Math.min(...lows) : null,
      volume_raw: volumes.length === orderedRows.length ? volumes.reduce((a, b) => a + b, 0) : null,
      source_rows: present.length,
      expected_rows: expected.length,
      source_times: present,
      missing_source_times: missing,
      bucket_state: bucketState,
      partial_kind: partialKind,
      is_complete: bucketState === "COMPLETED"
    });
  }

  return {
    bars,
    forming_partials: formingPartials,
    window_edge_partials: windowEdgePartials,
    true_bar_gaps: trueBarGaps
  };
}

function compareCompletedBars(nativeBars: RawMinuteBar[], aggregated: AggregatedBar[], maxCompare = 12) {
  const nativeCompleted = nativeBars.filter((b) => b.bar_state === "COMPLETED");
  const aggCompleted = aggregated.filter((b) => b.bucket_state === "COMPLETED");
  const nativeMap = new Map(nativeCompleted.map((b) => [b.time, b]));
  const aggMap = new Map(aggCompleted.map((b) => [b.time, b]));
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
    comparison_scope: "COMPLETED_BARS_ONLY",
    status: common.length === 0 ? "NO_COMMON_COMPLETED_BARS" : mismatchCount === 0 ? "PASS" : "CONFLICT",
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
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" }
    });
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

function commonMetadata(now = new Date()) {
  return {
    version: VERSION,
    session_state: sessionStateAt(now),
    session_calendar_note: "SESSION_STATE_IS_CLOCK_BASED; EXCHANGE_HOLIDAY_CALENDAR_NOT_EMBEDDED",
    completion_model: "TENCENT_LABEL_IS_BAR_END; COMPLETED_AFTER_BAR_END_PLUS_5_SECONDS",
    completion_grace_ms: COMPLETION_GRACE_MS,
    safety_status: "TEST_ONLY",
    formal_v3_trigger: "NOT_APPROVED",
    formal_trigger_allowed: false
  };
}

function bseUnavailableStatus(symbol: string, quote: any, one: any, native?: any) {
  if (!symbol.startsWith("bj")) return null;
  const oneNoRows = !one?.ok && Array.isArray(one?.fetch_meta?.errors) && one.fetch_meta.errors.some((x: string) => x.includes("NO_m1_ROWS"));
  const nativeNoRows = !native?.ok && Array.isArray(native?.fetch_meta?.errors) && native.fetch_meta.errors.some((x: string) => /NO_m(5|15)_ROWS/.test(x));
  if (quote?.ok && oneNoRows && (native == null || nativeNoRows)) return "UNSUPPORTED_UNVERIFIED_BSE_MINUTE";
  return null;
}

async function buildMinuteResponse(code: string, interval: Interval, limit: number) {
  const symbol = normalizeSymbol(code);
  const quote = await fetchQuoteForDiagnostics(symbol);

  if (interval === 1) {
    const raw = await fetchTencentMinuteRaw(symbol, 1, Math.min(320, limit + 8));
    const doneAt = new Date();
    const bseStatus = bseUnavailableStatus(symbol, quote, raw);

    if (!raw.ok) {
      return {
        ...commonMetadata(doneAt),
        symbol,
        interval: "1m",
        data_status: bseStatus ?? "DOWN",
        data_grade: "C",
        request_policy: "TENCENT_MKLINE_SERIAL_HOST_RETRY_NO_STALE_CACHE",
        preferred_path: null,
        returned_completed_bars: 0,
        completed_bars: [],
        forming_bar: null,
        auction_seed_bar: null,
        raw_tail: [],
        integrity: { ok: false, issues: ["NO_DATA"] },
        fetch_meta: raw.fetch_meta,
        quote_diagnostics: quote,
        fetched_at_beijing: beijingNowParts(doneAt).iso,
        timestamp_semantics: "BAR_END_SUPPORTED_BY_2026-08-12_LIVE_TESTS; 09:30_IS_AUCTION_SEED_NOT_REGULAR_1M",
        field_semantics: {
          columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
          volume_unit: "UNVERIFIED_TENCENT_RAW",
          raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
          raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT"
        },
        error: bseStatus ? "BSE minute rows unavailable on tested Tencent mkline paths; support remains unverified" : raw.error
      };
    }

    const bars = parseMinuteRows(raw.rows, raw.fetched_at);
    const completed = bars.filter((b) => b.bar_state === "COMPLETED").slice(-limit);
    const forming = bars.filter((b) => b.bar_state === "FORMING");
    const auctionSeeds = bars.filter((b) => b.bar_state === "AUCTION_SEED");

    return {
      ...commonMetadata(doneAt),
      symbol,
      interval: "1m",
      data_status: "OK",
      data_grade: "B",
      request_policy: "TENCENT_MKLINE_SERIAL_HOST_RETRY_NO_STALE_CACHE",
      preferred_path: "TENCENT_NATIVE_1M",
      returned_completed_bars: completed.length,
      completed_bars: completed,
      forming_bar: forming.length ? forming[forming.length - 1] : null,
      auction_seed_bar: auctionSeeds.length ? auctionSeeds[auctionSeeds.length - 1] : null,
      raw_tail: bars.slice(-6),
      integrity: integrityCheck(bars),
      fetch_meta: raw.fetch_meta,
      quote_diagnostics: quote,
      fetched_at_beijing: beijingNowParts(doneAt).iso,
      timestamp_semantics: "BAR_END_SUPPORTED_BY_2026-08-12_LIVE_TESTS; 09:30_IS_AUCTION_SEED_NOT_REGULAR_1M",
      field_semantics: {
        columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
        volume_unit: "UNVERIFIED_TENCENT_RAW",
        raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
        raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT"
      },
      error: null
    };
  }

  const oneMinNeed = Math.min(320, Math.max(120, interval * (limit + 5) + 16));
  const one = await fetchTencentMinuteRaw(symbol, 1, oneMinNeed);
  if (one.ok) await sleep(220);
  const native = await fetchTencentMinuteRaw(symbol, interval, Math.min(320, limit + 10));
  const doneAt = new Date();
  const bseStatus = bseUnavailableStatus(symbol, quote, one, native);

  let oneBars: RawMinuteBar[] = [];
  let aggregation: AggregationResult = {
    bars: [], forming_partials: [], window_edge_partials: [], true_bar_gaps: []
  };
  if (one.ok) {
    oneBars = parseMinuteRows(one.rows, one.fetched_at);
    aggregation = aggregate1mBars(oneBars, interval, one.fetched_at);
  }

  let nativeBars: RawMinuteBar[] = [];
  if (native.ok) nativeBars = parseMinuteRows(native.rows, native.fetched_at);

  const aggCompleted = aggregation.bars.filter((b) => b.bucket_state === "COMPLETED").slice(-limit);
  const aggForming = aggregation.bars.filter((b) => b.bucket_state === "FORMING");
  const nativeCompleted = nativeBars.filter((b) => b.bar_state === "COMPLETED").slice(-limit);
  const nativeForming = nativeBars.filter((b) => b.bar_state === "FORMING");

  const cross = one.ok && native.ok
    ? compareCompletedBars(nativeBars, aggregation.bars, Math.min(12, limit))
    : {
        comparison_scope: "COMPLETED_BARS_ONLY",
        status: "NOT_AVAILABLE",
        compared_count: 0,
        exact_match_count: 0,
        mismatch_count: 0,
        full_window_exact_match: false,
        full_window_within_tolerance: false,
        bars: []
      };

  const aggUsable = one.ok && aggCompleted.length > 0;
  const nativeUsable = native.ok && nativeCompleted.length > 0;
  const hasTrueGap = aggregation.true_bar_gaps.length > 0;

  let dataStatus = "DOWN";
  let dataGrade: "A" | "B" | "C" = "C";
  let preferredPath: string | null = null;

  if (bseStatus) {
    dataStatus = bseStatus;
  } else if (hasTrueGap) {
    dataStatus = "TRUE_BAR_GAP";
  } else if (aggUsable && nativeUsable && cross.status === "PASS") {
    dataStatus = "OK";
    dataGrade = "A";
    preferredPath = "AGGREGATED_FROM_TENCENT_1M_VERIFIED_BY_TENCENT_NATIVE_COMPLETED_ONLY";
  } else if (aggUsable && nativeUsable && cross.status === "CONFLICT") {
    dataStatus = "PATH_CONFLICT";
  } else if (aggUsable) {
    dataStatus = "DEGRADED_AGGREGATED_ONLY";
    dataGrade = "B";
    preferredPath = "AGGREGATED_FROM_TENCENT_1M_ONLY";
  } else if (nativeUsable) {
    dataStatus = "DEGRADED_NATIVE_ONLY";
    dataGrade = "B";
    preferredPath = "TENCENT_NATIVE_ONLY";
  }

  // Fail-closed: Grade C never exposes top-level bars as a preferred tradable stream.
  const topCompleted = dataGrade === "A"
    ? aggCompleted
    : dataGrade === "B"
      ? (preferredPath?.startsWith("AGGREGATED") ? aggCompleted : nativeCompleted)
      : [];
  const topForming = dataGrade === "A"
    ? (aggForming.length ? aggForming[aggForming.length - 1] : null)
    : dataGrade === "B"
      ? (preferredPath?.startsWith("AGGREGATED")
          ? (aggForming.length ? aggForming[aggForming.length - 1] : null)
          : (nativeForming.length ? nativeForming[nativeForming.length - 1] : null))
      : null;

  return {
    ...commonMetadata(doneAt),
    symbol,
    interval: `${interval}m`,
    data_status: dataStatus,
    data_grade: dataGrade,
    exact_5m_candidate_rule: interval === 5 ? "ONLY_GRADE_A_MAY_BECOME_FORMAL_AFTER_SEPARATE_V3_APPROVAL" : "NOT_APPLICABLE_OR_AUXILIARY",
    request_policy: "SEQUENTIAL_TENCENT_1M_PRIMARY_THEN_NATIVE_VERIFY_COMPLETED_ONLY",
    preferred_path: preferredPath,
    returned_completed_bars: topCompleted.length,
    completed_bars: topCompleted,
    forming_bar: topForming,
    aggregation_diagnostics: {
      forming_partials: aggregation.forming_partials,
      window_edge_partials: aggregation.window_edge_partials,
      true_bar_gaps: aggregation.true_bar_gaps,
      true_bar_gap_count: aggregation.true_bar_gaps.length
    },
    aggregated_from_1m_path: {
      status: aggUsable ? "OK" : one.ok ? "NO_COMPLETE_AGGREGATED_BARS" : "DOWN",
      completed_bars: aggCompleted,
      forming_bar: aggForming.length ? aggForming[aggForming.length - 1] : null,
      forming_partials: aggregation.forming_partials,
      window_edge_partials: aggregation.window_edge_partials,
      true_bar_gaps: aggregation.true_bar_gaps,
      source_1m_integrity: one.ok ? integrityCheck(oneBars) : { ok: false, issues: ["NO_1M_DATA"] },
      fetch_meta: one.fetch_meta,
      error: one.ok ? null : one.error,
      aggregation_model: "BAR_END_LABELS; AM_FIRST_BUCKET_INCLUDES_09:30_AUCTION_SEED; PM_FIRST_BUCKET_STARTS_13:01"
    },
    native_path: {
      status: nativeUsable ? "OK" : native.ok ? "NO_COMPLETE_NATIVE_BARS" : "DOWN",
      completed_bars: nativeCompleted,
      forming_bar: nativeForming.length ? nativeForming[nativeForming.length - 1] : null,
      raw_tail: nativeBars.slice(-6),
      integrity: native.ok ? integrityCheck(nativeBars) : { ok: false, issues: ["NO_NATIVE_DATA"] },
      fetch_meta: native.fetch_meta,
      error: native.ok ? null : native.error
    },
    cross_path_check: cross,
    quote_diagnostics: quote,
    fetched_at_beijing: beijingNowParts(doneAt).iso,
    timestamp_semantics: "BAR_END_SUPPORTED_BY_2026-08-12_LIVE_TESTS; CROSS_CHECK_COMPLETED_BARS_ONLY",
    field_semantics: {
      native_columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
      volume_unit: "UNVERIFIED_TENCENT_RAW",
      raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
      raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
      amount_yuan: "NOT_PROVIDED_IN_TEST_VERSION"
    },
    error: dataStatus === "DOWN"
      ? "Both Tencent minute paths unavailable"
      : bseStatus
        ? "BSE minute support remains unverified; tested Tencent mkline paths returned no rows"
        : dataStatus === "PATH_CONFLICT"
          ? "Completed-bar cross-path conflict; fail-closed"
          : dataStatus === "TRUE_BAR_GAP"
            ? "Confirmed missing source minute(s) inside an already completed bucket; fail-closed"
            : null
  };
}

function syntheticRaw(time: string, o: number, h: number, l: number, c: number, v: number, now: Date): RawMinuteBar {
  const pt = parseMinuteTime(time)!;
  const state = classifyRawMinute(pt, now);
  return {
    time: pt.normalized,
    raw_time: time.replace(/[- :]/g, ""),
    open: o,
    close: c,
    high: h,
    low: l,
    volume_raw: v,
    raw_extra_1: null,
    raw_extra_2: null,
    bar_state: state,
    is_complete_conservative: state === "COMPLETED"
  };
}

function bjDate(s: string) {
  const pt = parseMinuteTime(s);
  if (!pt) throw new Error(`Bad test datetime: ${s}`);
  return new Date(pt.epochMs);
}

function runLogicSelfTest() {
  const cases: any[] = [];

  const firstNow = bjDate("2026-08-12 09:35:10");
  const firstRows = [
    syntheticRaw("2026-08-12 09:30", 19.80, 19.80, 19.80, 19.80, 6391, firstNow),
    syntheticRaw("2026-08-12 09:31", 19.82, 19.83, 19.81, 19.82, 20000, firstNow),
    syntheticRaw("2026-08-12 09:32", 19.82, 19.83, 19.80, 19.81, 22000, firstNow),
    syntheticRaw("2026-08-12 09:33", 19.81, 19.82, 19.79, 19.80, 23000, firstNow),
    syntheticRaw("2026-08-12 09:34", 19.80, 19.81, 19.78, 19.79, 25000, firstNow),
    syntheticRaw("2026-08-12 09:35", 19.79, 19.80, 19.77, 19.78, 30027, firstNow)
  ];
  const firstAgg = aggregate1mBars(firstRows, 5, firstNow);
  const f = firstAgg.bars.find((b) => b.time.endsWith("09:35"));
  cases.push({
    name: "AM_FIRST_5M_INCLUDES_0930_AUCTION_SEED",
    pass: Boolean(f?.is_complete && f.source_rows === 6 && f.expected_rows === 6 && f.volume_raw === 126418 && firstAgg.true_bar_gaps.length === 0),
    observed: f ?? null
  });

  const ordinaryNow = bjDate("2026-08-12 09:40:10");
  const ordinaryRows = [36, 37, 38, 39, 40].map((m, i) => syntheticRaw(`2026-08-12 09:${m}`, 10 + i, 10.5 + i, 9.5 + i, 10.2 + i, 100 + i, ordinaryNow));
  const ordinaryAgg = aggregate1mBars(ordinaryRows, 5, ordinaryNow);
  const o = ordinaryAgg.bars.find((b) => b.time.endsWith("09:40"));
  cases.push({
    name: "ORDINARY_5M_COMPLETES_AFTER_BAR_END_PLUS_GRACE",
    pass: Boolean(o?.is_complete && ordinaryAgg.true_bar_gaps.length === 0),
    observed: o ?? null
  });

  const formingNow = bjDate("2026-08-12 09:42:30");
  const formingRows = [
    syntheticRaw("2026-08-12 09:41", 10, 10.2, 9.9, 10.1, 100, formingNow),
    syntheticRaw("2026-08-12 09:42", 10.1, 10.3, 10.0, 10.2, 120, formingNow)
  ];
  const formingAgg = aggregate1mBars(formingRows, 5, formingNow);
  cases.push({
    name: "FORMING_PARTIAL_IS_NOT_TRUE_GAP",
    pass: formingAgg.forming_partials.length === 1 && formingAgg.true_bar_gaps.length === 0,
    observed: formingAgg
  });

  const edgeNow = bjDate("2026-08-12 10:06:00");
  const edgeRows = [2, 3, 4, 5].map((m, i) => syntheticRaw(`2026-08-12 10:0${m}`, 10 + i, 10.5 + i, 9.5 + i, 10.2 + i, 100 + i, edgeNow));
  const edgeAgg = aggregate1mBars(edgeRows, 5, edgeNow);
  cases.push({
    name: "WINDOW_EDGE_PARTIAL_IS_NOT_TRUE_GAP",
    pass: edgeAgg.window_edge_partials.length === 1 && edgeAgg.true_bar_gaps.length === 0,
    observed: edgeAgg
  });

  const gapNow = bjDate("2026-08-12 10:11:00");
  const gapRows: RawMinuteBar[] = [];
  for (let m = 1; m <= 5; m++) gapRows.push(syntheticRaw(`2026-08-12 10:0${m}`, 10, 10.2, 9.9, 10.1, 100, gapNow));
  for (const m of [6, 7, 9, 10]) gapRows.push(syntheticRaw(`2026-08-12 10:${pad2(m)}`, 10, 10.2, 9.9, 10.1, 100, gapNow));
  const gapAgg = aggregate1mBars(gapRows, 5, gapNow);
  cases.push({
    name: "INTERNAL_MISSING_MINUTE_IS_TRUE_GAP",
    pass: gapAgg.true_bar_gaps.some((x) => x.startsWith("2026-08-12 10:10")),
    observed: gapAgg
  });

  const lunchNow = bjDate("2026-08-12 11:31:00");
  const lunchRows = [26, 27, 28, 29, 30].map((m, i) => syntheticRaw(`2026-08-12 11:${m}`, 19.77, 19.78, 19.76, 19.77, [2629, 2848, 1997, 2921, 2865][i], lunchNow));
  const lunchAgg = aggregate1mBars(lunchRows, 5, lunchNow);
  const l = lunchAgg.bars.find((b) => b.time.endsWith("11:30"));
  cases.push({
    name: "LUNCH_LAST_5M_IS_1126_TO_1130",
    pass: Boolean(l?.is_complete && l.source_times[0]?.endsWith("11:26") && l.source_times[4]?.endsWith("11:30")),
    observed: l ?? null
  });

  const pmNow = bjDate("2026-08-12 13:05:10");
  const pmRows = [1, 2, 3, 4, 5].map((m, i) => syntheticRaw(`2026-08-12 13:0${m}`, 19.77 - i * 0.005, 19.77, 19.75, 19.75, [11035, 5939, 5660, 5220, 5234][i], pmNow));
  const pmAgg = aggregate1mBars(pmRows, 5, pmNow);
  const p = pmAgg.bars.find((b) => b.time.endsWith("13:05"));
  cases.push({
    name: "PM_FIRST_5M_IS_1301_TO_1305_ONLY",
    pass: Boolean(p?.is_complete && p.source_rows === 5 && p.source_times.every((x) => x.includes("13:0"))),
    observed: p ?? null
  });

  const nativeForCross: RawMinuteBar[] = [
    syntheticRaw("2026-08-12 13:05", 19.77, 19.77, 19.75, 19.75, 33088, bjDate("2026-08-12 13:06:00")),
    syntheticRaw("2026-08-12 13:10", 19.75, 19.76, 19.74, 19.75, 9999, bjDate("2026-08-12 13:06:00"))
  ];
  const cross = compareCompletedBars(nativeForCross, pmAgg.bars, 12);
  cases.push({
    name: "CROSS_CHECK_IGNORES_FORMING_BARS",
    pass: cross.status === "PASS" && cross.compared_count === 1 && cross.mismatch_count === 0,
    observed: cross
  });

  const failed = cases.filter((x) => !x.pass);
  return {
    version: VERSION,
    ok: failed.length === 0,
    mode: "OFFLINE_LOGIC_SELFTEST_NO_LIVE_MARKET_REQUIRED",
    cases,
    summary: { total: cases.length, passed: cases.length - failed.length, failed: failed.length },
    safety_status: "TEST_ONLY",
    formal_v3_trigger: "NOT_APPROVED"
  };
}

async function buildHealthResponse() {
  const symbol = "sz300059";
  const started = new Date();
  const quote = await fetchQuoteForDiagnostics(symbol);
  const one = await fetchTencentMinuteRaw(symbol, 1, 140);
  if (one.ok) await sleep(220);
  const native5 = await fetchTencentMinuteRaw(symbol, 5, 30);
  const ended = new Date();

  const oneBars = one.ok ? parseMinuteRows(one.rows, one.fetched_at) : [];
  const agg = one.ok ? aggregate1mBars(oneBars, 5, one.fetched_at) : {
    bars: [], forming_partials: [], window_edge_partials: [], true_bar_gaps: []
  };
  const nativeBars = native5.ok ? parseMinuteRows(native5.rows, native5.fetched_at) : [];
  const cross = one.ok && native5.ok ? compareCompletedBars(nativeBars, agg.bars, 12) : {
    comparison_scope: "COMPLETED_BARS_ONLY",
    status: "NOT_AVAILABLE",
    compared_count: 0,
    exact_match_count: 0,
    mismatch_count: 0,
    full_window_exact_match: false,
    full_window_within_tolerance: false,
    bars: []
  };

  const m1Completed = oneBars.filter((b) => b.bar_state === "COMPLETED");
  const m1Forming = oneBars.filter((b) => b.bar_state === "FORMING");
  const m5Completed = agg.bars.filter((b) => b.bucket_state === "COMPLETED");
  const m5Forming = agg.bars.filter((b) => b.bucket_state === "FORMING");
  const m1Ok = one.ok && integrityCheck(oneBars).ok;
  const m5A = one.ok && native5.ok && cross.status === "PASS" && agg.true_bar_gaps.length === 0 && m5Completed.length > 0;

  return {
    ...commonMetadata(ended),
    ok: Boolean(quote.ok && m1Ok && m5A),
    fetched_at_beijing: beijingNowParts(ended).iso,
    started_at_beijing: beijingNowParts(started).iso,
    readiness: {
      quote: quote.ok ? "READY_FOR_TEST" : "DOWN",
      minute_1m: m1Ok ? "READY_FOR_TEST" : "DOWN",
      minute_5m: m5A ? "GRADE_A_TEST_READY" : "NOT_GRADE_A",
      formal_v3_trigger: "NOT_APPROVED"
    },
    state: {
      session_state: sessionStateAt(ended),
      latest_completed_1m: m1Completed.length ? m1Completed[m1Completed.length - 1].time : null,
      forming_1m: m1Forming.length ? m1Forming[m1Forming.length - 1] : null,
      auction_seed_1m: oneBars.filter((b) => b.bar_state === "AUCTION_SEED").slice(-1)[0] ?? null,
      latest_completed_5m: m5Completed.length ? m5Completed[m5Completed.length - 1].time : null,
      forming_5m: m5Forming.length ? m5Forming[m5Forming.length - 1] : null,
      true_gap_count: agg.true_bar_gaps.length,
      window_edge_partial_count: agg.window_edge_partials.length,
      forming_partial_count: agg.forming_partials.length,
      cross_completed_status: cross.status
    },
    checks: {
      quote,
      minute_1m: {
        ok: m1Ok,
        integrity: one.ok ? integrityCheck(oneBars) : { ok: false, issues: ["NO_1M_DATA"] },
        fetch_meta: one.fetch_meta
      },
      minute_5m: {
        grade_a: m5A,
        aggregation_diagnostics: {
          forming_partials: agg.forming_partials,
          window_edge_partials: agg.window_edge_partials,
          true_bar_gaps: agg.true_bar_gaps
        },
        cross_path_check: cross,
        one_minute_fetch_meta: one.fetch_meta,
        native_fetch_meta: native5.fetch_meta
      }
    }
  };
}

function createServer() {
  const server = new McpServer({
    name: "Tencent Minute Kline Test",
    version: MCP_VERSION
  });

  server.registerTool(
    "get_tencent_minute_kline",
    {
      description:
        "腾讯分钟K RC1测试。仅开放1/5/15分钟；5/15分钟用腾讯1分钟本地聚合，并只对双方已完成K与腾讯原生周期交叉验证。含09:30集合竞价seed、午休/下午session、窗口边缘/真缺口分类和fail-closed。仅测试，禁止直接作为BSI-SWING_V3正式触发。",
      inputSchema: {
        code: z.string().describe("证券代码。普通股票可写300059；指数/易歧义代码请显式写交易所前缀，例如sh000300；ETF建议写sh510300/sz159919"),
        interval: z.union([z.literal(1), z.literal(5), z.literal(15)]).default(5),
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
              data_grade: "C",
              safety_status: "TEST_ONLY",
              formal_v3_trigger: "NOT_APPROVED",
              formal_trigger_allowed: false,
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
        "腾讯分钟K RC1健康检查。复用一次quote、一次1m和一次原生5m请求，输出session、latest completed、forming、真缺口、窗口边缘和仅completed跨路径校验。",
      inputSchema: {}
    },
    async () => {
      const result = await buildHealthResponse();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "tencent_minute_logic_selftest",
    {
      description:
        "离线逻辑自测，不依赖交易日或实时行情。验证09:30集合竞价seed、普通5m完成、forming不误报gap、窗口边缘不误报gap、真缺口、午休、下午重开以及cross-check只比较completed。",
      inputSchema: {}
    },
    async () => {
      const result = runLogicSelfTest();
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
