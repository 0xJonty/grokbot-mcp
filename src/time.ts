const TZ = "Australia/Sydney";

const fmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** "2026-11-22 08:40" in Australia/Sydney. */
export function sydney(ms: number | string | undefined | null): string {
  const n = typeof ms === "string" ? (/^\d+$/.test(ms) ? Number(ms) : Date.parse(ms)) : ms;
  if (n == null || !Number.isFinite(n)) return "?";
  const p = Object.fromEntries(fmt.formatToParts(new Date(n)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function relative(ms: number, now = Date.now()): string {
  let d = Math.round((ms - now) / 60000);
  const future = d >= 0;
  d = Math.abs(d);
  const s = d >= 1440 ? `${Math.floor(d / 1440)}d ${Math.floor((d % 1440) / 60)}h` : d >= 60 ? `${Math.floor(d / 60)}h ${d % 60}m` : `${d}m`;
  return future ? `in ${s}` : `${s} ago`;
}
