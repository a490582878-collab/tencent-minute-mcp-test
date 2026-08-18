import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const VERSION = "TENCENT_MINUTE_V1.0";
const MCP_VERSION = "1.0.0";
const SERVER_FORMAL_RELEASE_ENABLED = true;
const SAFETY_STATUS = "FORMAL_RELEASE";
const RELEASE_STATUS = "V1_0_RELEASED";
const FORMAL_V3_TRIGGER = "APPROVED_WITH_HARD_GATE";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const BAR_CLOSE_GRACE_MS = 5_000;
const CROSS_SYNC_GRACE_MS = 30_000;
const ALLOWED_INTERVALS = [1, 5, 15] as const;
type Interval = (typeof ALLOWED_INTERVALS)[number];

type BarState = "COMPLETED" | "FORMING" | "AUCTION_SEED" | "OUT_OF_SESSION";
type SessionState =
  | "NON_TRADING_DAY"
  | "CALENDAR_UNVERIFIED"
  | "PRE_OPEN"
  | "OPENING_AUCTION"
  | "POST_AUCTION_PRE_CONTINUOUS"
  | "AM_SESSION"
  | "LUNCH_BREAK"
  | "PM_SESSION"
  | "POST_CLOSE";

type PartialKind =
  | "FORMING_PARTIAL"
  | "FULL_ROWS_SETTLING"
  | "CLOSED_SETTLING_PARTIAL"
  | "WINDOW_EDGE_PARTIAL"
  | "TRUE_BAR_GAP";

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


type VolumeProfile = {
  asset_class: "A_SHARE_STOCK" | "STAR_STOCK" | "ETF_FUND" | "INDEX" | "BSE_UNVERIFIED" | "UNKNOWN";
  raw_unit: "SHARE" | "LOT_100_SHARES" | "LOT_100_UNITS" | "UNVERIFIED_TENCENT_RAW";
  multiplier_to_base_units: number | null;
  normalized_unit: "SHARE" | "FUND_UNIT" | null;
  semantics_status: "EMPIRICALLY_VALIDATED_FAMILY_RULE_V1" | "UNVERIFIED_FAIL_CLOSED";
  relative_volume_usable: boolean;
  absolute_normalization_usable: boolean;
  evidence_note: string;
};

function volumeProfileForSymbol(symbol: string): VolumeProfile {
  const s = symbol.toLowerCase();

  if (s.startsWith("bj")) {
    return {
      asset_class: "BSE_UNVERIFIED",
      raw_unit: "UNVERIFIED_TENCENT_RAW",
      multiplier_to_base_units: null,
      normalized_unit: null,
      semantics_status: "UNVERIFIED_FAIL_CLOSED",
      relative_volume_usable: false,
      absolute_normalization_usable: false,
      evidence_note: "BSE minute support is not validated on the tested Tencent mkline path; no absolute-volume normalization is allowed."
    };
  }

  if (/^sh000\d{3}$/.test(s) || /^sz399\d{3}$/.test(s)) {
    return {
      asset_class: "INDEX",
      raw_unit: "UNVERIFIED_TENCENT_RAW",
      multiplier_to_base_units: null,
      normalized_unit: null,
      semantics_status: "UNVERIFIED_FAIL_CLOSED",
      relative_volume_usable: true,
      absolute_normalization_usable: false,
      evidence_note: "Index minute bars are usable for same-symbol relative-volume comparisons, but V1.0 does not assert a universal absolute unit for index volume."
    };
  }

  if (/^sh688\d{3}$/.test(s)) {
    return {
      asset_class: "STAR_STOCK",
      raw_unit: "SHARE",
      multiplier_to_base_units: 1,
      normalized_unit: "SHARE",
      semantics_status: "EMPIRICALLY_VALIDATED_FAMILY_RULE_V1",
      relative_volume_usable: true,
      absolute_normalization_usable: true,
      evidence_note: "Empirically validated on STAR samples sh688981 and sh688256 by Tencent minute/raw-volume versus independent turnover-amount price reconstruction. This is empirical, not official Tencent field documentation."
    };
  }

  if (/^sh5\d{5}$/.test(s) || /^sz1\d{5}$/.test(s)) {
    return {
      asset_class: "ETF_FUND",
      raw_unit: "LOT_100_UNITS",
      multiplier_to_base_units: 100,
      normalized_unit: "FUND_UNIT",
      semantics_status: "EMPIRICALLY_VALIDATED_FAMILY_RULE_V1",
      relative_volume_usable: true,
      absolute_normalization_usable: true,
      evidence_note: "Empirically validated on ETF samples sh510300 and sz159919. Raw volume is normalized with x100 fund units for absolute-volume use."
    };
  }

  if (/^sh6\d{5}$/.test(s) || /^sz[03]\d{5}$/.test(s)) {
    return {
      asset_class: "A_SHARE_STOCK",
      raw_unit: "LOT_100_SHARES",
      multiplier_to_base_units: 100,
      normalized_unit: "SHARE",
      semantics_status: "EMPIRICALLY_VALIDATED_FAMILY_RULE_V1",
      relative_volume_usable: true,
      absolute_normalization_usable: true,
      evidence_note: "Empirical family rule supported by live samples including sh601066, sz300059 and sz300308. Raw volume is normalized with x100 shares. This is empirical, not official Tencent field documentation."
    };
  }

  return {
    asset_class: "UNKNOWN",
    raw_unit: "UNVERIFIED_TENCENT_RAW",
    multiplier_to_base_units: null,
    normalized_unit: null,
    semantics_status: "UNVERIFIED_FAIL_CLOSED",
    relative_volume_usable: true,
    absolute_normalization_usable: false,
    evidence_note: "V1.0 has no validated absolute-volume unit rule for this symbol family. Same-symbol relative-volume ratios may still use raw volume because the unit cancels."
  };
}

function normalizedVolume(raw: number | null | undefined, profile: VolumeProfile): number | null {
  if (raw == null || !profile.absolute_normalization_usable || profile.multiplier_to_base_units == null) return null;
  return Math.round(raw * profile.multiplier_to_base_units);
}

function withNormalizedVolume<T extends { volume_raw: number | null }>(bar: T, profile: VolumeProfile) {
  return {
    ...bar,
    volume_normalized: normalizedVolume(bar.volume_raw, profile),
    volume_normalized_unit: profile.normalized_unit,
    volume_profile_status: profile.semantics_status
  };
}

function withQuoteVolumeNormalization(quote: any, profile: VolumeProfile) {
  if (!quote?.ok) return quote;
  return {
    ...quote,
    volume_normalized_quote: normalizedVolume(quote.volume_raw_quote, profile),
    volume_normalized_unit: profile.normalized_unit,
    volume_profile_status: profile.semantics_status
  };
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

const OFFICIAL_2026_CLOSED_DATES = new Set<string>([
  // 元旦
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  // 清明节
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午节
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋节
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 国庆节
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"
]);

function tradingCalendarInfo(date: string) {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return {
      coverage: "2026_SSE_SZSE_OFFICIAL",
      status: "INVALID_DATE",
      is_trading_day: null as boolean | null,
      reason: "INVALID_DATE",
      source: "SSE_SZSE_2026_OFFICIAL_CLOSURE_NOTICES"
    };
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year !== 2026) {
    return {
      coverage: "2026_SSE_SZSE_OFFICIAL",
      status: "OUTSIDE_EMBEDDED_COVERAGE",
      is_trading_day: null as boolean | null,
      reason: "CALENDAR_UNVERIFIED_OUTSIDE_2026",
      source: "SSE_SZSE_2026_OFFICIAL_CLOSURE_NOTICES"
    };
  }

  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return {
      coverage: "2026_SSE_SZSE_OFFICIAL",
      status: "VERIFIED_2026",
      is_trading_day: false,
      reason: "WEEKEND",
      source: "SSE_SZSE_2026_OFFICIAL_CLOSURE_NOTICES"
    };
  }
  if (OFFICIAL_2026_CLOSED_DATES.has(date)) {
    return {
      coverage: "2026_SSE_SZSE_OFFICIAL",
      status: "VERIFIED_2026",
      is_trading_day: false,
      reason: "OFFICIAL_EXCHANGE_HOLIDAY",
      source: "SSE_SZSE_2026_OFFICIAL_CLOSURE_NOTICES"
    };
  }
  return {
    coverage: "2026_SSE_SZSE_OFFICIAL",
    status: "VERIFIED_2026",
    is_trading_day: true,
    reason: "REGULAR_TRADING_WEEKDAY",
    source: "SSE_SZSE_2026_OFFICIAL_CLOSURE_NOTICES"
  };
}

function sessionStateAt(now = new Date()): SessionState {
  const bj = beijingNowParts(now);
  const cal = tradingCalendarInfo(bj.date);
  if (cal.is_trading_day === false) return "NON_TRADING_DAY";
  if (cal.is_trading_day == null) return "CALENDAR_UNVERIFIED";

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
  const bj = beijingNowParts(now);

  if (pt.date === bj.date) {
    const cal = tradingCalendarInfo(pt.date);
    if (cal.is_trading_day !== true) return "OUT_OF_SESSION";
  }

  if (isAuctionSeedMinute(pt.totalMinutes)) return "AUCTION_SEED";
  if (!isRegularTradingMinute(pt.totalMinutes)) return "OUT_OF_SESSION";

  if (pt.date < bj.date) return "COMPLETED";
  if (pt.date > bj.date) return "FORMING";

  return now.getTime() >= pt.epochMs + BAR_CLOSE_GRACE_MS ? "COMPLETED" : "FORMING";
}

type BucketTimingPhase = "FORMING" | "CLOSED_SETTLING" | "VERIFICATION_ELIGIBLE";

function bucketTimingPhase(label: string, now = new Date()): BucketTimingPhase {
  const pt = parseMinuteTime(label);
  if (!pt) return "FORMING";
  const bj = beijingNowParts(now);
  if (pt.date < bj.date) return "VERIFICATION_ELIGIBLE";
  if (pt.date > bj.date) return "FORMING";
  const cal = tradingCalendarInfo(pt.date);
  if (cal.is_trading_day !== true) return "FORMING";
  const ageMs = now.getTime() - pt.epochMs;
  if (ageMs < BAR_CLOSE_GRACE_MS) return "FORMING";
  if (ageMs < CROSS_SYNC_GRACE_MS) return "CLOSED_SETTLING";
  return "VERIFICATION_ELIGIBLE";
}

function isCrossVerificationEligible(label: string, now = new Date()) {
  return bucketTimingPhase(label, now) === "VERIFICATION_ELIGIBLE";
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
  bucket_state: "COMPLETED" | "FORMING" | "CLOSED_SETTLING" | "WINDOW_EDGE_PARTIAL" | "TRUE_BAR_GAP";
  partial_kind: PartialKind | null;
  is_complete: boolean;
};

type AggregationResult = {
  bars: AggregatedBar[];
  forming_partials: string[];
  full_rows_settling: string[];
  closed_settling: string[];
  closed_settling_partials: string[];
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
  const fullRowsSettling: string[] = [];
  const closedSettling: string[] = [];
  const closedSettlingPartials: string[] = [];
  const windowEdgePartials: string[] = [];
  const trueBarGaps: string[] = [];

  for (const label of generateBucketLabels(raw1m, interval)) {
    const rows = (groups.get(label) ?? []).sort((a, b) => a.time.localeCompare(b.time));
    const expected = expectedSourceTimes(label, interval);
    const rowMap = new Map(rows.map((r) => [r.time, r]));
    const present = expected.filter((t) => rowMap.has(t));
    const missing = expected.filter((t) => !rowMap.has(t));
    const timingPhase = bucketTimingPhase(label, now);
    const sessionKey = sessionKeyForTime(label);
    const earliest = sessionKey ? earliestBySession.get(sessionKey) : undefined;
    const allMissingBeforeWindow = Boolean(earliest && missing.length > 0 && missing.every((t) => t < earliest));

    let bucketState: AggregatedBar["bucket_state"];
    let partialKind: PartialKind | null = null;
    const allExpectedPresent = missing.length === 0;
    const allSourcesReady = present.every((t) => {
      const r = rowMap.get(t)!;
      return r.bar_state === "COMPLETED" || r.bar_state === "AUCTION_SEED";
    });

    if (timingPhase === "FORMING") {
      bucketState = "FORMING";
      if (allExpectedPresent) {
        partialKind = "FULL_ROWS_SETTLING";
        fullRowsSettling.push(`${label}: ${present.length}/${expected.length}`);
      } else {
        partialKind = "FORMING_PARTIAL";
        formingPartials.push(`${label}: ${present.length}/${expected.length}`);
      }
    } else if (timingPhase === "CLOSED_SETTLING") {
      bucketState = "CLOSED_SETTLING";
      if (!allExpectedPresent || !allSourcesReady) {
        partialKind = "CLOSED_SETTLING_PARTIAL";
        closedSettlingPartials.push(`${label}: ${present.length}/${expected.length}; missing=${missing.join(",")}`);
      } else {
        closedSettling.push(`${label}: ${present.length}/${expected.length}`);
      }
    } else if (!allExpectedPresent && allMissingBeforeWindow) {
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
    full_rows_settling: fullRowsSettling,
    closed_settling: closedSettling,
    closed_settling_partials: closedSettlingPartials,
    window_edge_partials: windowEdgePartials,
    true_bar_gaps: trueBarGaps
  };
}

function compareCompletedBars(nativeBars: RawMinuteBar[], aggregated: AggregatedBar[], maxCompare = 12, now = new Date()) {
  const nativeSettling = nativeBars.filter((b) => b.bar_state === "COMPLETED" && !isCrossVerificationEligible(b.time, now));
  const aggSettling = aggregated.filter((b) => b.bucket_state === "CLOSED_SETTLING");
  const nativeCompleted = nativeBars.filter((b) => b.bar_state === "COMPLETED" && isCrossVerificationEligible(b.time, now));
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
        if (diff > 1e-12) priceExact = false;
      }
    }

    let volumeOk = false;
    let volumeExact = false;
    let volumeDiff: number | null = null;
    if (n.volume_raw != null && a.volume_raw != null) {
      volumeDiff = Math.abs(n.volume_raw - a.volume_raw);
      const rel = volumeDiff / Math.max(1, Math.abs(n.volume_raw));
      volumeOk = volumeDiff <= 2 || rel <= 0.0005;
      volumeExact = volumeDiff <= 1e-9;
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
    comparison_scope: "VERIFICATION_ELIGIBLE_COMPLETED_BARS_ONLY",
    status: common.length === 0 ? "NO_COMMON_COMPLETED_BARS" : mismatchCount === 0 ? "PASS" : "CONFLICT",
    compared_count: common.length,
    exact_match_count: exactMatchCount,
    mismatch_count: mismatchCount,
    full_window_exact_match: common.length > 0 && exactMatchCount === common.length,
    full_window_within_tolerance: common.length > 0 && mismatchCount === 0,
    settling_excluded_labels: [...new Set([
      ...nativeSettling.map((b) => b.time),
      ...aggSettling.map((b) => b.time)
    ])].sort(),
    settling_excluded_count: new Set([
      ...nativeSettling.map((b) => b.time),
      ...aggSettling.map((b) => b.time)
    ]).size,
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
      volume_raw_quote: num(f[36]),
      turnover_wan: num(f[37])
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function commonMetadata(now = new Date()) {
  const bj = beijingNowParts(now);
  const cal = tradingCalendarInfo(bj.date);
  return {
    version: VERSION,
    session_state: sessionStateAt(now),
    trading_calendar: {
      date: bj.date,
      ...cal,
      formal_gate: cal.is_trading_day === true ? "CALENDAR_PASS" : "CALENDAR_FAIL_CLOSED"
    },
    session_calendar_note: "2026_SSE_SZSE_OFFICIAL_HOLIDAYS_EMBEDDED; WEEKENDS_CLOSED; OUTSIDE_2026_CALENDAR_UNVERIFIED_FAIL_CLOSED",
    completion_model: "TENCENT_LABEL_IS_BAR_END; BAR_CLOSED_AFTER_5S; CROSS_VERIFICATION_ELIGIBLE_AFTER_30S",
    completion_grace_ms: BAR_CLOSE_GRACE_MS,
    bar_close_grace_ms: BAR_CLOSE_GRACE_MS,
    cross_sync_grace_ms: CROSS_SYNC_GRACE_MS,
    safety_status: SAFETY_STATUS,
    release_status: RELEASE_STATUS,
    formal_v3_trigger: FORMAL_V3_TRIGGER,
    formal_trigger_allowed: false
  };
}

function requestWindowPlan(interval: Interval, requestedLimit: number) {
  if (interval === 1) {
    const effectiveLimit = Math.min(60, requestedLimit);
    return {
      policy: "AUTO_RECENT_WINDOW",
      requested_limit: requestedLimit,
      effective_limit: effectiveLimit,
      reliable_max_completed_bars: 60,
      requested_limit_supported: requestedLimit <= 60,
      one_minute_count: Math.min(320, Math.max(80, effectiveLimit + 20)),
      native_count: null,
      note: "1m tool schema limits completed output to <=60 bars; extra raw rows are fetched for state/auction diagnostics"
    };
  }

  const reliableMax = interval === 5 ? 60 : 20;
  const effectiveLimit = Math.min(requestedLimit, reliableMax);
  const oneMinuteCount = Math.min(320, Math.max(interval === 5 ? 140 : 240, interval * effectiveLimit + 20));
  return {
    policy: "AUTO_RECENT_WINDOW_WITH_CAPACITY_DIAGNOSTICS",
    requested_limit: requestedLimit,
    effective_limit: effectiveLimit,
    reliable_max_completed_bars: reliableMax,
    requested_limit_supported: requestedLimit <= reliableMax,
    one_minute_count: oneMinuteCount,
    native_count: Math.min(320, effectiveLimit + 10),
    note: requestedLimit <= reliableMax
      ? "Requested completed-bar window fits the Tencent ~320-row 1m cap with reserved edge/forming diagnostics"
      : `Requested ${requestedLimit} bars exceeds conservative ${interval}m reliable window ${reliableMax}; output is capped visibly rather than silently under-covering`
  };
}

function computeVolumeValidation(symbol: string, oneBars: RawMinuteBar[], quote: any, now = new Date()) {
  const profile = volumeProfileForSymbol(symbol);
  const bj = beijingNowParts(now);
  const session = sessionStateAt(now);
  const currentDay = oneBars
    .filter((b) => b.time.startsWith(`${bj.date} `) && b.bar_state !== "OUT_OF_SESSION")
    .sort((a, b) => a.time.localeCompare(b.time));

  const usable = currentDay.filter((b) => b.volume_raw != null);
  const sumRaw = usable.length === currentDay.length && usable.length > 0
    ? usable.reduce((acc, b) => acc + (b.volume_raw as number), 0)
    : null;
  const earliest = currentDay[0]?.time ?? null;
  const latest = currentDay[currentDay.length - 1]?.time ?? null;
  const startsAtAuctionSeed = Boolean(earliest?.endsWith("09:30"));
  const quotePt = quote?.quote_time ? parseMinuteTime(quote.quote_time) : null;
  const latestPt = latest ? parseMinuteTime(latest) : null;
  const quoteSameDate = Boolean(quotePt && quotePt.date === bj.date);
  const coversQuoteMinute = Boolean(quotePt && latestPt && latestPt.date === quotePt.date && latestPt.totalMinutes >= quotePt.totalMinutes);
  const lunchFrozenCoverage = Boolean(
    session === "LUNCH_BREAK" && quotePt && latestPt && quoteSameDate &&
    latestPt.totalMinutes === 11 * 60 + 30 &&
    quotePt.totalMinutes >= 11 * 60 + 30 && quotePt.totalMinutes < 13 * 60
  );
  const postCloseFrozenCoverage = Boolean(
    session === "POST_CLOSE" && quotePt && latestPt && quoteSameDate &&
    latestPt.totalMinutes === 15 * 60 && quotePt.totalMinutes >= 15 * 60
  );
  const sessionFrozenCoverage = lunchFrozenCoverage || postCloseFrozenCoverage;
  const coverageSatisfied = coversQuoteMinute || sessionFrozenCoverage;
  const quoteVolumeRaw = typeof quote?.volume_raw_quote === "number" ? quote.volume_raw_quote : null;
  const diff = sumRaw != null && quoteVolumeRaw != null ? Math.abs(sumRaw - quoteVolumeRaw) : null;
  const rel = diff != null && quoteVolumeRaw != null ? diff / Math.max(1, Math.abs(quoteVolumeRaw)) : null;

  let status = "INSUFFICIENT_COVERAGE";
  if (sumRaw == null || quoteVolumeRaw == null || !quoteSameDate || !startsAtAuctionSeed || !coverageSatisfied) {
    status = "INSUFFICIENT_COVERAGE";
  } else if ((diff as number) <= 2 || (rel as number) <= 0.001) {
    status = sessionFrozenCoverage ? "SESSION_FROZEN_MATCH" : "WITHIN_LIVE_TOLERANCE";
  } else {
    status = "MISMATCH_OR_SNAPSHOT_SKEW";
  }

  const scaleSupported = status === "WITHIN_LIVE_TOLERANCE" || status === "SESSION_FROZEN_MATCH";

  return {
    status,
    current_date: bj.date,
    session_state: session,
    current_day_rows: currentDay.length,
    earliest_current_day_bar: earliest,
    latest_current_day_bar: latest,
    starts_at_0930_auction_seed: startsAtAuctionSeed,
    quote_time: quote?.quote_time ?? null,
    quote_same_date: quoteSameDate,
    covers_quote_minute: coversQuoteMinute,
    session_frozen_coverage: sessionFrozenCoverage,
    session_frozen_reason: lunchFrozenCoverage ? "LUNCH_BREAK_LAST_VALID_MINUTE_11_30" : postCloseFrozenCoverage ? "POST_CLOSE_LAST_VALID_MINUTE_15_00" : null,
    sum_volume_raw_current_day: sumRaw,
    quote_volume_raw_current_day: quoteVolumeRaw,
    absolute_difference: diff,
    relative_difference: rel,
    raw_scale_consistency: scaleSupported ? "SUPPORTED" : status === "INSUFFICIENT_COVERAGE" ? "NOT_TESTED" : "MISMATCH_OR_TIMING_SKEW",
    volume_profile: profile,
    normalized_sum_current_day: normalizedVolume(sumRaw, profile),
    normalized_quote_volume: normalizedVolume(quoteVolumeRaw, profile),
    use_absolute_normalized_volume: profile.absolute_normalization_usable,
    use_relative_volume_ratios: profile.relative_volume_usable,
    use_for_formal_gate: false,
    note: "Raw same-symbol volume is suitable for relative-volume ratios when the data path is healthy. Lunch/post-close frozen sessions are recognized as complete snapshots. Absolute normalization is allowed only for empirically validated symbol families; this is not official Tencent field documentation."
  };
}

function buildV3CandidateGate(args: {
  symbol: string;
  interval: Interval;
  dataGrade: "A" | "B" | "C";
  crossStatus: string;
  trueGapCount: number;
  completedBars: Array<{ time: string }>;
  now: Date;
  hasSettlingBar?: boolean;
}) {
  const { symbol, interval, dataGrade, crossStatus, trueGapCount, completedBars, now, hasSettlingBar = false } = args;
  const reasons: string[] = [];
  const cal = tradingCalendarInfo(beijingNowParts(now).date);
  const latestVerified = completedBars.length ? completedBars[completedBars.length - 1].time : null;

  if (interval !== 5) reasons.push("INTERVAL_NOT_EXACT_5M");
  if (cal.is_trading_day !== true) reasons.push("CALENDAR_NOT_VERIFIED_TRADING_DAY");
  if (symbol.startsWith("bj")) reasons.push("BSE_MINUTE_NOT_VALIDATED");
  if (dataGrade !== "A") reasons.push(`DATA_GRADE_${dataGrade}`);
  if (crossStatus !== "PASS") reasons.push(`CROSS_${crossStatus}`);
  if (trueGapCount > 0) reasons.push("TRUE_BAR_GAP_PRESENT");
  if (hasSettlingBar) reasons.push("LATEST_BAR_SYNC_SETTLING");
  if (!latestVerified) reasons.push("NO_VERIFIED_COMPLETED_BAR");

  const dataGatePass = reasons.length === 0;
  return {
    gate_name: "BSI_SWING_V3_EXACT_5M_DATA_GATE",
    data_gate_pass: dataGatePass,
    eligible_bar_time: dataGatePass ? latestVerified : null,
    required_conditions: [
      "interval=5m",
      "trading calendar PASS",
      "data_grade=A",
      "completed-bar cross_path_check=PASS",
      "true_bar_gap_count=0",
      "non-BSE validated path",
      "no sync-settling bar pending verification",
      "verified completed bar exists"
    ],
    reasons,
    server_formal_release_enabled: SERVER_FORMAL_RELEASE_ENABLED,
    formal_trigger_allowed: SERVER_FORMAL_RELEASE_ENABLED && dataGatePass,
    note: dataGatePass
      ? "V1.0 formal hard gate passes for the latest verified completed 5m bar."
      : "Fail-closed: the response does not satisfy the formal exact 5m hard gate."
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
  const volumeProfile = volumeProfileForSymbol(symbol);
  const windowPlan = requestWindowPlan(interval, limit);
  const quote = withQuoteVolumeNormalization(await fetchQuoteForDiagnostics(symbol), volumeProfile);

  if (interval === 1) {
    const raw = await fetchTencentMinuteRaw(symbol, 1, windowPlan.one_minute_count);
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
        request_window: windowPlan,
        preferred_path: null,
        returned_completed_bars: 0,
        completed_bars: [],
        forming_bar: null,
        auction_seed_bar: null,
        raw_tail: [],
        integrity: { ok: false, issues: ["NO_DATA"] },
        fetch_meta: raw.fetch_meta,
        quote_diagnostics: quote,
        volume_profile: volumeProfile,
        fetched_at_beijing: beijingNowParts(doneAt).iso,
        timestamp_semantics: "BAR_END_SUPPORTED_BY_2026-08-12_LIVE_TESTS; 09:30_IS_AUCTION_SEED_NOT_REGULAR_1M",
        field_semantics: {
          columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
          volume_unit: volumeProfile.raw_unit,
          volume_normalized_unit: volumeProfile.normalized_unit,
          volume_semantics_status: volumeProfile.semantics_status,
          relative_volume_usable: volumeProfile.relative_volume_usable,
          absolute_normalization_usable: volumeProfile.absolute_normalization_usable,
          raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
          raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT"
        },
        error: bseStatus ? "BSE minute rows unavailable on tested Tencent mkline paths; support remains unverified" : raw.error
      };
    }

    const bars = parseMinuteRows(raw.rows, raw.fetched_at);
    const completed = bars.filter((b) => b.bar_state === "COMPLETED").slice(-windowPlan.effective_limit);
    const forming = bars.filter((b) => b.bar_state === "FORMING");
    const auctionSeeds = bars.filter((b) => b.bar_state === "AUCTION_SEED");

    return {
      ...commonMetadata(doneAt),
      symbol,
      interval: "1m",
      exact_5m_trigger_eligible: false,
      data_status: "OK",
      data_grade: "B",
      request_policy: "TENCENT_MKLINE_SERIAL_HOST_RETRY_NO_STALE_CACHE",
      request_window: windowPlan,
      preferred_path: "TENCENT_NATIVE_1M",
      returned_completed_bars: completed.length,
      completed_bars: completed.map((b) => withNormalizedVolume(b, volumeProfile)),
      forming_bar: forming.length ? withNormalizedVolume(forming[forming.length - 1], volumeProfile) : null,
      auction_seed_bar: auctionSeeds.length ? withNormalizedVolume(auctionSeeds[auctionSeeds.length - 1], volumeProfile) : null,
      raw_tail: bars.slice(-6).map((b) => withNormalizedVolume(b, volumeProfile)),
      integrity: integrityCheck(bars),
      fetch_meta: raw.fetch_meta,
      quote_diagnostics: quote,
      volume_profile: volumeProfile,
      volume_validation: computeVolumeValidation(symbol, bars, quote, doneAt),
      fetched_at_beijing: beijingNowParts(doneAt).iso,
      timestamp_semantics: "BAR_END_SUPPORTED_BY_2026-08-12_LIVE_TESTS; 09:30_IS_AUCTION_SEED_NOT_REGULAR_1M",
      field_semantics: {
        columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
        volume_unit: volumeProfile.raw_unit,
        volume_normalized_unit: volumeProfile.normalized_unit,
        volume_semantics_status: volumeProfile.semantics_status,
        relative_volume_usable: volumeProfile.relative_volume_usable,
        absolute_normalization_usable: volumeProfile.absolute_normalization_usable,
        raw_extra_1: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT",
        raw_extra_2: "UNVERIFIED_DO_NOT_TREAT_AS_AMOUNT"
      },
      error: null
    };
  }

  const one = await fetchTencentMinuteRaw(symbol, 1, windowPlan.one_minute_count);
  if (one.ok) await sleep(220);
  const native = await fetchTencentMinuteRaw(symbol, interval, windowPlan.native_count ?? Math.min(320, windowPlan.effective_limit + 10));
  const doneAt = new Date();
  const bseStatus = bseUnavailableStatus(symbol, quote, one, native);

  let oneBars: RawMinuteBar[] = [];
  let aggregation: AggregationResult = {
    bars: [], forming_partials: [], full_rows_settling: [], closed_settling: [], closed_settling_partials: [], window_edge_partials: [], true_bar_gaps: []
  };
  if (one.ok) {
    oneBars = parseMinuteRows(one.rows, one.fetched_at);
    aggregation = aggregate1mBars(oneBars, interval, one.fetched_at);
  }

  let nativeBars: RawMinuteBar[] = [];
  if (native.ok) nativeBars = parseMinuteRows(native.rows, native.fetched_at);

  const aggCompleted = aggregation.bars.filter((b) => b.bucket_state === "COMPLETED").slice(-windowPlan.effective_limit);
  const aggForming = aggregation.bars.filter((b) => b.bucket_state === "FORMING");
  const aggSettling = aggregation.bars.filter((b) => b.bucket_state === "CLOSED_SETTLING");
  const nativeCompleted = nativeBars.filter((b) => b.bar_state === "COMPLETED" && isCrossVerificationEligible(b.time, doneAt)).slice(-windowPlan.effective_limit);
  const nativeSettling = nativeBars.filter((b) => b.bar_state === "COMPLETED" && !isCrossVerificationEligible(b.time, doneAt));
  const nativeForming = nativeBars.filter((b) => b.bar_state === "FORMING");

  const cross = one.ok && native.ok
    ? compareCompletedBars(nativeBars, aggregation.bars, Math.min(12, windowPlan.effective_limit), doneAt)
    : {
        comparison_scope: "VERIFICATION_ELIGIBLE_COMPLETED_BARS_ONLY",
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
    dataStatus = (aggSettling.length > 0 || nativeSettling.length > 0) ? "SYNC_SETTLING" : "OK";
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

  const topSettling = dataGrade === "A"
    ? (aggSettling.length ? aggSettling[aggSettling.length - 1] : null)
    : null;

  const v3CandidateGate = buildV3CandidateGate({
    symbol,
    interval,
    dataGrade,
    crossStatus: cross.status,
    trueGapCount: aggregation.true_bar_gaps.length,
    completedBars: topCompleted,
    now: doneAt,
    hasSettlingBar: aggSettling.length > 0 || nativeSettling.length > 0
  });

  return {
    ...commonMetadata(doneAt),
    symbol,
    interval: `${interval}m`,
    data_status: dataStatus,
    data_grade: dataGrade,
    exact_5m_candidate_rule: interval === 5 ? "V1_0_FORMAL_HARD_GATE_REQUIRES_GRADE_A_CROSS_PASS_NO_TRUE_GAP_CALENDAR_PASS_NO_SYNC_SETTLING" : "NOT_APPLICABLE_OR_AUXILIARY",
    request_policy: "SEQUENTIAL_TENCENT_1M_PRIMARY_THEN_NATIVE_VERIFY_COMPLETED_ONLY",
    request_window: windowPlan,
    preferred_path: preferredPath,
    returned_completed_bars: topCompleted.length,
    completed_bars: topCompleted.map((b) => withNormalizedVolume(b, volumeProfile)),
    forming_bar: topForming ? withNormalizedVolume(topForming as any, volumeProfile) : null,
    settling_bar: topSettling ? withNormalizedVolume(topSettling, volumeProfile) : null,
    latest_bar_verification: topSettling ? "SYNC_SETTLING" : topForming ? "FORMING" : dataGrade === "A" ? "VERIFIED" : "UNAVAILABLE",
    formal_candidate_status: interval === 5
      ? (topSettling
          ? "WAIT_SYNC_SETTLING"
          : v3CandidateGate.formal_trigger_allowed
            ? "FORMAL_TRIGGER_ELIGIBLE"
            : "NOT_ELIGIBLE")
      : "NOT_APPLICABLE_OR_AUXILIARY",
    exact_5m_trigger_eligible: interval === 5 ? v3CandidateGate.formal_trigger_allowed : false,
    formal_trigger_allowed: interval === 5 ? v3CandidateGate.formal_trigger_allowed : false,
    v3_candidate_gate: v3CandidateGate,
    aggregation_diagnostics: {
      forming_partials: aggregation.forming_partials,
      full_rows_settling: aggregation.full_rows_settling,
      closed_settling: aggregation.closed_settling,
      closed_settling_partials: aggregation.closed_settling_partials,
      window_edge_partials: aggregation.window_edge_partials,
      true_bar_gaps: aggregation.true_bar_gaps,
      true_bar_gap_count: aggregation.true_bar_gaps.length
    },
    aggregated_from_1m_path: {
      status: aggUsable ? "OK" : one.ok ? "NO_COMPLETE_AGGREGATED_BARS" : "DOWN",
      completed_bars: aggCompleted.map((b) => withNormalizedVolume(b, volumeProfile)),
      forming_bar: aggForming.length ? withNormalizedVolume(aggForming[aggForming.length - 1], volumeProfile) : null,
      settling_bar: aggSettling.length ? withNormalizedVolume(aggSettling[aggSettling.length - 1], volumeProfile) : null,
      forming_partials: aggregation.forming_partials,
      full_rows_settling: aggregation.full_rows_settling,
      closed_settling: aggregation.closed_settling,
      closed_settling_partials: aggregation.closed_settling_partials,
      window_edge_partials: aggregation.window_edge_partials,
      true_bar_gaps: aggregation.true_bar_gaps,
      source_1m_integrity: one.ok ? integrityCheck(oneBars) : { ok: false, issues: ["NO_1M_DATA"] },
      fetch_meta: one.fetch_meta,
      error: one.ok ? null : one.error,
      aggregation_model: "BAR_END_LABELS; AM_FIRST_BUCKET_INCLUDES_09:30_AUCTION_SEED; PM_FIRST_BUCKET_STARTS_13:01"
    },
    native_path: {
      status: nativeUsable ? "OK" : native.ok ? "NO_COMPLETE_NATIVE_BARS" : "DOWN",
      completed_bars: nativeCompleted.map((b) => withNormalizedVolume(b, volumeProfile)),
      forming_bar: nativeForming.length ? withNormalizedVolume(nativeForming[nativeForming.length - 1], volumeProfile) : null,
      settling_bar: nativeSettling.length ? withNormalizedVolume(nativeSettling[nativeSettling.length - 1], volumeProfile) : null,
      raw_tail: nativeBars.slice(-6).map((b) => withNormalizedVolume(b, volumeProfile)),
      integrity: native.ok ? integrityCheck(nativeBars) : { ok: false, issues: ["NO_NATIVE_DATA"] },
      fetch_meta: native.fetch_meta,
      error: native.ok ? null : native.error
    },
    cross_path_check: cross,
    quote_diagnostics: quote,
    volume_profile: volumeProfile,
    volume_validation: computeVolumeValidation(symbol, oneBars, quote, doneAt),
    fetched_at_beijing: beijingNowParts(doneAt).iso,
    timestamp_semantics: "BAR_END_SUPPORTED_BY_2026-08-12_LIVE_TESTS; 5S_BAR_CLOSE_GRACE; 30S_CROSS_SYNC_SETTLING; CROSS_CHECK_VERIFICATION_ELIGIBLE_BARS_ONLY",
    field_semantics: {
      native_columns: ["time", "open", "close", "high", "low", "volume_raw", "raw_extra_1", "raw_extra_2"],
      volume_unit: volumeProfile.raw_unit,
      volume_normalized_unit: volumeProfile.normalized_unit,
      volume_semantics_status: volumeProfile.semantics_status,
      relative_volume_usable: volumeProfile.relative_volume_usable,
      absolute_normalization_usable: volumeProfile.absolute_normalization_usable,
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
    pass: Boolean(f?.bucket_state === "CLOSED_SETTLING" && f.source_rows === 6 && f.expected_rows === 6 && f.volume_raw === 126418 && firstAgg.true_bar_gaps.length === 0),
    observed: f ?? null
  });

  const ordinaryNow = bjDate("2026-08-12 09:40:31");
  const ordinaryRows = [36, 37, 38, 39, 40].map((m, i) => syntheticRaw(`2026-08-12 09:${m}`, 10 + i, 10.5 + i, 9.5 + i, 10.2 + i, 100 + i, ordinaryNow));
  const ordinaryAgg = aggregate1mBars(ordinaryRows, 5, ordinaryNow);
  const o = ordinaryAgg.bars.find((b) => b.time.endsWith("09:40"));
  cases.push({
    name: "ORDINARY_5M_COMPLETES_AFTER_CROSS_SYNC_GRACE",
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
    pass: Boolean(p?.bucket_state === "CLOSED_SETTLING" && p.source_rows === 5 && p.source_times.every((x) => x.includes("13:0"))),
    observed: p ?? null
  });

  const crossNow = bjDate("2026-08-12 13:06:00");
  const pmRowsForCross = [1, 2, 3, 4, 5].map((m, i) => syntheticRaw(`2026-08-12 13:0${m}`, 19.77 - i * 0.005, 19.77, 19.75, 19.75, [11035, 5939, 5660, 5220, 5234][i], crossNow));
  const pmAggForCross = aggregate1mBars(pmRowsForCross, 5, crossNow);
  const nativeForCross: RawMinuteBar[] = [
    syntheticRaw("2026-08-12 13:05", 19.77, 19.77, 19.75, 19.75, 33088, crossNow),
    syntheticRaw("2026-08-12 13:10", 19.75, 19.76, 19.74, 19.75, 9999, crossNow)
  ];
  const cross = compareCompletedBars(nativeForCross, pmAggForCross.bars, 12, crossNow);
  cases.push({
    name: "CROSS_CHECK_IGNORES_FORMING_BARS",
    pass: cross.status === "PASS" && cross.compared_count === 1 && cross.mismatch_count === 0,
    observed: cross
  });


  const preCloseNow = bjDate("2026-08-12 10:20:03");
  const syncRows: RawMinuteBar[] = [];
  for (let m = 11; m <= 20; m++) {
    syncRows.push(syntheticRaw(`2026-08-12 10:${pad2(m)}`, 19.4, 19.5, 19.3, 19.4, m <= 15 ? 100 : [4000, 4200, 4300, 5000, 5545][m - 16], preCloseNow));
  }
  const preCloseAgg = aggregate1mBars(syncRows, 5, preCloseNow);
  const preCloseBar = preCloseAgg.bars.find((b) => b.time.endsWith("10:20"));
  cases.push({
    name: "FULL_ROWS_BEFORE_5S_IS_SETTLING_NOT_GAP",
    pass: Boolean(preCloseBar?.bucket_state === "FORMING" && preCloseBar.partial_kind === "FULL_ROWS_SETTLING" && preCloseAgg.true_bar_gaps.length === 0),
    observed: preCloseBar ?? null
  });

  const settlingNow = bjDate("2026-08-12 10:20:12");
  const settlingAgg = aggregate1mBars(syncRows, 5, settlingNow);
  const settlingBar = settlingAgg.bars.find((b) => b.time.endsWith("10:20"));
  cases.push({
    name: "BAR_AFTER_5S_BEFORE_30S_IS_CLOSED_SETTLING",
    pass: Boolean(settlingBar?.bucket_state === "CLOSED_SETTLING" && settlingBar.is_complete === false && settlingAgg.true_bar_gaps.length === 0),
    observed: settlingBar ?? null
  });

  const nativeSettlingTest: RawMinuteBar[] = [
    syntheticRaw("2026-08-12 10:15", 19.4, 19.5, 19.3, 19.4, 500, settlingNow),
    syntheticRaw("2026-08-12 10:20", 19.4, 19.5, 19.3, 19.4, 22545, settlingNow)
  ];
  const settlingCross = compareCompletedBars(nativeSettlingTest, settlingAgg.bars, 12, settlingNow);
  cases.push({
    name: "CROSS_IGNORES_CLOSED_SETTLING_MISMATCH",
    pass: settlingCross.status === "PASS" && settlingCross.settling_excluded_labels.some((x: string) => x.endsWith("10:20")) && settlingCross.mismatch_count === 0,
    observed: settlingCross
  });

  const verifyNow = bjDate("2026-08-12 10:20:31");
  const verifiedSyncRows: RawMinuteBar[] = [];
  for (let m = 11; m <= 20; m++) {
    verifiedSyncRows.push(syntheticRaw(`2026-08-12 10:${pad2(m)}`, 19.4, 19.5, 19.3, 19.4, m <= 15 ? 100 : [4000, 4200, 4300, 5000, 5545][m - 16], verifyNow));
  }
  const verifiedAgg = aggregate1mBars(verifiedSyncRows, 5, verifyNow);
  const staleNative: RawMinuteBar[] = [
    syntheticRaw("2026-08-12 10:15", 19.4, 19.5, 19.3, 19.4, 500, verifyNow),
    syntheticRaw("2026-08-12 10:20", 19.4, 19.5, 19.3, 19.4, 22545, verifyNow)
  ];
  const staleCross = compareCompletedBars(staleNative, verifiedAgg.bars, 12, verifyNow);
  cases.push({
    name: "PERSISTENT_MISMATCH_AFTER_30S_FAILS_CLOSED",
    pass: staleCross.status === "CONFLICT" && staleCross.mismatch_count >= 1,
    observed: staleCross
  });

  const finalVolume = verifiedAgg.bars.find((b) => b.time.endsWith("10:20"))?.volume_raw ?? 0;
  const syncedNative: RawMinuteBar[] = [
    syntheticRaw("2026-08-12 10:15", 19.4, 19.5, 19.3, 19.4, 500, verifyNow),
    syntheticRaw("2026-08-12 10:20", 19.4, 19.5, 19.3, 19.4, finalVolume, verifyNow)
  ];
  const syncedCross = compareCompletedBars(syncedNative, verifiedAgg.bars, 12, verifyNow);
  cases.push({
    name: "MATCH_AFTER_30S_BECOMES_VERIFIED",
    pass: syncedCross.status === "PASS" && syncedCross.mismatch_count === 0,
    observed: syncedCross
  });

  const calendarWeekday = tradingCalendarInfo("2026-08-17");
  cases.push({
    name: "TRADING_CALENDAR_REGULAR_WEEKDAY_PASS",
    pass: calendarWeekday.is_trading_day === true,
    observed: calendarWeekday
  });

  const calendarHoliday = tradingCalendarInfo("2026-10-01");
  cases.push({
    name: "TRADING_CALENDAR_OFFICIAL_HOLIDAY_FAIL_CLOSED",
    pass: calendarHoliday.is_trading_day === false && calendarHoliday.reason === "OFFICIAL_EXCHANGE_HOLIDAY",
    observed: calendarHoliday
  });

  const calendarWeekend = tradingCalendarInfo("2026-08-16");
  cases.push({
    name: "TRADING_CALENDAR_WEEKEND_FAIL_CLOSED",
    pass: calendarWeekend.is_trading_day === false && calendarWeekend.reason === "WEEKEND",
    observed: calendarWeekend
  });

  const outsideCalendar = tradingCalendarInfo("2027-01-04");
  cases.push({
    name: "TRADING_CALENDAR_OUTSIDE_COVERAGE_UNVERIFIED",
    pass: outsideCalendar.is_trading_day == null && outsideCalendar.status === "OUTSIDE_EMBEDDED_COVERAGE",
    observed: outsideCalendar
  });

  cases.push({
    name: "SESSION_STATE_HOLIDAY_IS_NON_TRADING_DAY",
    pass: sessionStateAt(bjDate("2026-10-01 10:00:00")) === "NON_TRADING_DAY",
    observed: sessionStateAt(bjDate("2026-10-01 10:00:00"))
  });

  cases.push({
    name: "SESSION_STATE_OUTSIDE_CALENDAR_IS_UNVERIFIED",
    pass: sessionStateAt(bjDate("2027-01-04 10:00:00")) === "CALENDAR_UNVERIFIED",
    observed: sessionStateAt(bjDate("2027-01-04 10:00:00"))
  });

  const volumeNow = bjDate("2026-08-12 09:32:00");
  const volumeRows = [
    syntheticRaw("2026-08-12 09:30", 10, 10, 10, 10, 100, volumeNow),
    syntheticRaw("2026-08-12 09:31", 10, 10.1, 9.9, 10.05, 200, volumeNow)
  ];
  const volumeCheck = computeVolumeValidation("sz300059", volumeRows, { quote_time: "20260812093130", volume_raw_quote: 300 }, volumeNow);
  cases.push({
    name: "VOLUME_RAW_SCALE_DIAGNOSTIC_MATCHES_QUOTE_WITHOUT_BEING_FORMAL_GATE",
    pass: volumeCheck.status === "WITHIN_LIVE_TOLERANCE" && volumeCheck.raw_scale_consistency === "SUPPORTED" && volumeCheck.use_for_formal_gate === false,
    observed: volumeCheck
  });

  const starProfile = volumeProfileForSymbol("sh688981");
  cases.push({
    name: "STAR_VOLUME_PROFILE_IS_SHARE_X1",
    pass: starProfile.raw_unit === "SHARE" && starProfile.multiplier_to_base_units === 1 && normalizedVolume(2398805, starProfile) === 2398805,
    observed: starProfile
  });

  const mainProfile = volumeProfileForSymbol("sh601066");
  cases.push({
    name: "MAIN_BOARD_VOLUME_PROFILE_IS_LOT_X100",
    pass: mainProfile.raw_unit === "LOT_100_SHARES" && mainProfile.multiplier_to_base_units === 100 && normalizedVolume(9978, mainProfile) === 997800,
    observed: mainProfile
  });

  const gemProfile = volumeProfileForSymbol("sz300059");
  cases.push({
    name: "CHINEXT_VOLUME_PROFILE_IS_LOT_X100",
    pass: gemProfile.raw_unit === "LOT_100_SHARES" && normalizedVolume(71613, gemProfile) === 7161300,
    observed: gemProfile
  });

  const etfProfile = volumeProfileForSymbol("sh510300");
  cases.push({
    name: "ETF_VOLUME_PROFILE_IS_LOT_100_UNITS",
    pass: etfProfile.raw_unit === "LOT_100_UNITS" && etfProfile.normalized_unit === "FUND_UNIT" && normalizedVolume(188264, etfProfile) === 18826400,
    observed: etfProfile
  });

  const indexProfile = volumeProfileForSymbol("sh000300");
  cases.push({
    name: "INDEX_ABSOLUTE_VOLUME_FAILS_CLOSED_BUT_RELATIVE_VOLUME_REMAINS_USABLE",
    pass: indexProfile.absolute_normalization_usable === false && indexProfile.relative_volume_usable === true && normalizedVolume(1000, indexProfile) == null,
    observed: indexProfile
  });

  cases.push({
    name: "NORMALIZED_VOLUME_IS_INTEGERIZED_WITHOUT_FLOATING_TAIL",
    pass: normalizedVolume(131796.02, mainProfile) === 13179602 && normalizedVolume(53658.200000000004, mainProfile) === 5365820,
    observed: { a: normalizedVolume(131796.02, mainProfile), b: normalizedVolume(53658.200000000004, mainProfile) }
  });

  const lunchAuditNow = bjDate("2026-08-12 11:36:00");
  const lunchAuditRows = [
    syntheticRaw("2026-08-12 09:30", 10, 10, 10, 10, 100, lunchAuditNow),
    syntheticRaw("2026-08-12 11:30", 10, 10, 10, 10, 200, lunchAuditNow)
  ];
  const lunchAudit = computeVolumeValidation("sz300059", lunchAuditRows, { quote_time: "20260812113600", volume_raw_quote: 300 }, lunchAuditNow);
  cases.push({
    name: "LUNCH_BREAK_VOLUME_AUDIT_RECOGNIZES_FROZEN_1130_SNAPSHOT",
    pass: lunchAudit.status === "SESSION_FROZEN_MATCH" && lunchAudit.session_frozen_coverage === true && lunchAudit.raw_scale_consistency === "SUPPORTED",
    observed: lunchAudit
  });

  const gateProfileNow = bjDate("2026-08-12 10:20:31");
  const gate = buildV3CandidateGate({
    symbol: "sz300059",
    interval: 5,
    dataGrade: "A",
    crossStatus: "PASS",
    trueGapCount: 0,
    completedBars: [{ time: "2026-08-12 10:20" }],
    now: gateProfileNow
  });
  cases.push({
    name: "V1_FORMAL_HARD_GATE_ALLOWS_STABLE_GRADE_A_5M",
    pass: gate.data_gate_pass === true && gate.eligible_bar_time === "2026-08-12 10:20" && gate.formal_trigger_allowed === true && gate.server_formal_release_enabled === true,
    observed: gate
  });

  const settlingGate = buildV3CandidateGate({
    symbol: "sz300059",
    interval: 5,
    dataGrade: "A",
    crossStatus: "PASS",
    trueGapCount: 0,
    completedBars: [{ time: "2026-08-12 10:15" }],
    now: bjDate("2026-08-12 10:20:12"),
    hasSettlingBar: true
  });
  cases.push({
    name: "SYNC_SETTLING_BLOCKS_FORMAL_TRIGGER",
    pass: settlingGate.data_gate_pass === false && settlingGate.formal_trigger_allowed === false && settlingGate.reasons.includes("LATEST_BAR_SYNC_SETTLING"),
    observed: settlingGate
  });

  const cappedWindow = requestWindowPlan(15, 60);
  cases.push({
    name: "FIFTEEN_MINUTE_OVERSIZED_LIMIT_IS_VISIBLY_CAPPED",
    pass: cappedWindow.requested_limit_supported === false && cappedWindow.effective_limit === 20 && cappedWindow.one_minute_count === 320,
    observed: cappedWindow
  });

  const mixedNow = bjDate("2026-08-12 10:11:00");
  const mixedRows: RawMinuteBar[] = [
    syntheticRaw("2026-08-12 10:03", 10, 10.2, 9.9, 10.1, 100, mixedNow),
    syntheticRaw("2026-08-12 10:04", 10, 10.2, 9.9, 10.1, 100, mixedNow),
    syntheticRaw("2026-08-12 10:05", 10, 10.2, 9.9, 10.1, 100, mixedNow),
    syntheticRaw("2026-08-12 10:06", 10, 10.2, 9.9, 10.1, 100, mixedNow),
    syntheticRaw("2026-08-12 10:07", 10, 10.2, 9.9, 10.1, 100, mixedNow),
    syntheticRaw("2026-08-12 10:09", 10, 10.2, 9.9, 10.1, 100, mixedNow),
    syntheticRaw("2026-08-12 10:10", 10, 10.2, 9.9, 10.1, 100, mixedNow)
  ];
  const mixedAgg = aggregate1mBars(mixedRows, 5, mixedNow);
  cases.push({
    name: "WINDOW_EDGE_DOES_NOT_HIDE_INTERNAL_TRUE_GAP",
    pass: mixedAgg.true_bar_gaps.some((x) => x.startsWith("2026-08-12 10:10")),
    observed: mixedAgg
  });

  const failed = cases.filter((x) => !x.pass);
  return {
    version: VERSION,
    ok: failed.length === 0,
    mode: "OFFLINE_LOGIC_SELFTEST_NO_LIVE_MARKET_REQUIRED",
    cases,
    summary: { total: cases.length, passed: cases.length - failed.length, failed: failed.length },
    safety_status: SAFETY_STATUS,
    release_status: RELEASE_STATUS,
    formal_v3_trigger: FORMAL_V3_TRIGGER
  };
}

async function buildHealthResponse() {
  const symbol = "sz300059";
  const started = new Date();
  const one = await fetchTencentMinuteRaw(symbol, 1, 280);
  if (one.ok) await sleep(220);
  const native5 = await fetchTencentMinuteRaw(symbol, 5, 50);
  const volumeProfile = volumeProfileForSymbol(symbol);
  const quote = withQuoteVolumeNormalization(await fetchQuoteForDiagnostics(symbol), volumeProfile);
  const ended = new Date();

  const oneBars = one.ok ? parseMinuteRows(one.rows, one.fetched_at) : [];
  const agg = one.ok ? aggregate1mBars(oneBars, 5, one.fetched_at) : {
    bars: [], forming_partials: [], full_rows_settling: [], closed_settling: [], closed_settling_partials: [], window_edge_partials: [], true_bar_gaps: []
  };
  const nativeBars = native5.ok ? parseMinuteRows(native5.rows, native5.fetched_at) : [];
  const cross = one.ok && native5.ok ? compareCompletedBars(nativeBars, agg.bars, 12, ended) : {
    comparison_scope: "VERIFICATION_ELIGIBLE_COMPLETED_BARS_ONLY",
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
  const m5Settling = agg.bars.filter((b) => b.bucket_state === "CLOSED_SETTLING");
  const m1Ok = one.ok && integrityCheck(oneBars).ok;
  const m5A = one.ok && native5.ok && cross.status === "PASS" && agg.true_bar_gaps.length === 0 && m5Completed.length > 0;
  const healthV3Gate = buildV3CandidateGate({
    symbol,
    interval: 5,
    dataGrade: m5A ? "A" : "C",
    crossStatus: cross.status,
    trueGapCount: agg.true_bar_gaps.length,
    completedBars: m5Completed,
    now: ended,
    hasSettlingBar: m5Settling.length > 0
  });

  return {
    ...commonMetadata(ended),
    ok: Boolean(quote.ok && m1Ok && m5A),
    fetched_at_beijing: beijingNowParts(ended).iso,
    started_at_beijing: beijingNowParts(started).iso,
    readiness: {
      quote: quote.ok ? "READY_FOR_TEST" : "DOWN",
      minute_1m: m1Ok ? "READY_FOR_TEST" : "DOWN",
      minute_5m: m5A ? (m5Settling.length ? "GRADE_A_READY_LATEST_BAR_SYNC_SETTLING" : "GRADE_A_FORMAL_READY") : "NOT_GRADE_A",
      formal_v3_trigger: FORMAL_V3_TRIGGER,
      release_status: RELEASE_STATUS,
      formal_trigger_allowed: healthV3Gate.formal_trigger_allowed
    },
    formal_trigger_allowed: healthV3Gate.formal_trigger_allowed,
    exact_5m_trigger_eligible: healthV3Gate.formal_trigger_allowed,
    v3_candidate_gate: healthV3Gate,
    state: {
      session_state: sessionStateAt(ended),
      latest_completed_1m: m1Completed.length ? m1Completed[m1Completed.length - 1].time : null,
      forming_1m: m1Forming.length ? m1Forming[m1Forming.length - 1] : null,
      auction_seed_1m: oneBars.filter((b) => b.bar_state === "AUCTION_SEED").slice(-1)[0] ?? null,
      latest_completed_5m: m5Completed.length ? m5Completed[m5Completed.length - 1].time : null,
      latest_verified_completed_5m: m5Completed.length ? m5Completed[m5Completed.length - 1].time : null,
      forming_5m: m5Forming.length ? m5Forming[m5Forming.length - 1] : null,
      settling_5m: m5Settling.length ? m5Settling[m5Settling.length - 1] : null,
      true_gap_count: agg.true_bar_gaps.length,
      window_edge_partial_count: agg.window_edge_partials.length,
      forming_partial_count: agg.forming_partials.length,
      full_rows_settling_count: agg.full_rows_settling.length,
      closed_settling_count: agg.closed_settling.length,
      closed_settling_partial_count: agg.closed_settling_partials.length,
      cross_completed_status: cross.status,
      calendar_gate: tradingCalendarInfo(beijingNowParts(ended).date).is_trading_day === true ? "PASS" : "FAIL_CLOSED"
    },
    checks: {
      quote,
      volume_profile: volumeProfile,
      volume_validation: computeVolumeValidation(symbol, oneBars, quote, ended),
      minute_1m: {
        ok: m1Ok,
        integrity: one.ok ? integrityCheck(oneBars) : { ok: false, issues: ["NO_1M_DATA"] },
        fetch_meta: one.fetch_meta
      },
      minute_5m: {
        grade_a: m5A,
        aggregation_diagnostics: {
          forming_partials: agg.forming_partials,
          full_rows_settling: agg.full_rows_settling,
          closed_settling: agg.closed_settling,
          closed_settling_partials: agg.closed_settling_partials,
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
    name: "Tencent Minute Kline V1",
    version: MCP_VERSION
  });

  server.registerTool(
    "get_tencent_minute_kline",
    {
      description:
        "腾讯分钟K正式V1.0。验证周期为1/5/15分钟；30/60仅为旧工具快照兼容输入并结构化拒绝。5/15分钟采用腾讯1分钟聚合 + 腾讯原生周期的已完成K交叉验证；包含09:30集合竞价seed、午休/下午session、30秒路径同步settling、真缺口fail-closed、按证券家族的成交量归一化和BSI-SWING_V3 EXACT_5M正式硬门。只有5m Grade A + completed cross PASS + 无真缺口 + 交易日历PASS + 无sync settling时 formal_trigger_allowed=true。",
      inputSchema: {
        code: z.string().describe("证券代码。普通股票可写300059；指数/易歧义代码请显式写交易所前缀，例如sh000300；ETF建议写sh510300/sz159919"),
        interval: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).default(5),
        limit: z.number().int().min(5).max(60).default(20)
      }
    },
    async ({ code, interval, limit }) => {
      try {
        if (interval === 30 || interval === 60) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                version: VERSION,
                data_status: "UNSUPPORTED_INTERVAL",
                data_grade: "C",
                requested_interval: `${interval}m`,
                supported_intervals: ["1m", "5m", "15m"],
                compatibility_note: "30m/60m inputs are accepted only to remain compatible with older ChatGPT tool snapshots; formal V1.0 does not treat them as validated intervals because the Tencent 1m request window is capped.",
                safety_status: SAFETY_STATUS,
                release_status: RELEASE_STATUS,
                formal_v3_trigger: FORMAL_V3_TRIGGER,
                exact_5m_trigger_eligible: false,
                formal_trigger_allowed: false,
                error: "30m/60m are intentionally disabled in formal V1.0"
              }, null, 2)
            }]
          };
        }
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
              safety_status: SAFETY_STATUS,
              release_status: RELEASE_STATUS,
              formal_v3_trigger: FORMAL_V3_TRIGGER,
              exact_5m_trigger_eligible: false,
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
        "腾讯分钟K正式V1.0健康检查。复用一次quote、一次1m和一次原生5m请求，输出session、latest completed、forming/settling、真缺口、成交量profile、正式V3硬门和仅completed跨路径校验。",
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
        "正式V1.0离线逻辑自测，不依赖交易日或实时行情。验证09:30集合竞价seed、5秒bar-close、30秒cross-sync settling、forming/window-edge/真缺口、午休、下午重开、成交量整数归一化、午休volume audit和V3正式硬门。",
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
