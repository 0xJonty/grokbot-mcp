// Display time zone: GROKBOT_TZ (IANA name, e.g. "Europe/London") if valid, else the system zone.
// Resolved per call (cheap, cached per zone) so the env var can change without a restart in tests.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch {
    return null; // invalid IANA name
  }
  formatters.set(zone, f);
  return f;
}

/** The system's IANA zone, or "UTC" if the runtime can't tell. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** GROKBOT_TZ, ignoring blank and an unsubstituted MCPB placeholder like "${user_config.timezone}". */
function override(): string | undefined {
  const want = process.env.GROKBOT_TZ?.trim();
  return want && !want.startsWith("${") ? want : undefined;
}

/** The zone used for every time this server shows. */
export function timeZone(): string {
  const want = override();
  if (want && formatter(want)) return want;
  return systemTimeZone();
}

/** True when GROKBOT_TZ is set but not a valid IANA zone name (shown by grokbot_status). */
export function timeZoneOverrideInvalid(): boolean {
  const want = override();
  return !!want && !formatter(want);
}

/** "2026-11-22 08:40" in the display zone. */
export function localTime(ms: number | string | undefined | null): string {
  const n = typeof ms === "string" ? (/^\d+$/.test(ms) ? Number(ms) : Date.parse(ms)) : ms;
  if (n == null || !Number.isFinite(n)) return "?";
  const f = formatter(timeZone()) ?? formatter("UTC")!;
  const p = Object.fromEntries(f.formatToParts(new Date(n)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function relative(ms: number, now = Date.now()): string {
  let d = Math.round((ms - now) / 60000);
  const future = d >= 0;
  d = Math.abs(d);
  const s = d >= 1440 ? `${Math.floor(d / 1440)}d ${Math.floor((d % 1440) / 60)}h` : d >= 60 ? `${Math.floor(d / 60)}h ${d % 60}m` : `${d}m`;
  return future ? `in ${s}` : `${s} ago`;
}
