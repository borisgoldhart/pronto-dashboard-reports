/**
 * Date-preset resolution — the server-side twin of resolvePreset() in
 * public/app.js. Kept byte-for-byte equivalent so a spec frozen on the server
 * covers exactly the window the browser would have asked for.
 *
 * Why this matters: the report cache is keyed on the built query URL, which
 * carries dateFrom/dateTo. A rolling preset therefore produces a NEW cache key
 * every day. That is fine for a signed-in user (a miss just refetches) but it
 * is what made anonymous share links go blank after a day or two — the public
 * view is cache-only, so a moved key reads as "no data". Freezing a spec pins
 * the dates, which pins the cache key, which makes a shared view reproducible
 * forever.
 */

const isoD = (d) => d.toISOString().slice(0, 10);

/** Presets whose window moves as the calendar advances. */
export const ROLLING_PRESETS = new Set([
  "This Week", "Last 7 Days", "This Month", "Last 2 Months", "Last 3 Months", "YTD",
]);

/** Resolve a preset name against `now` (default: today, UTC). null = Custom Dates. */
export function resolvePreset(preset, now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), day = now.getUTCDate();
  const U = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));
  const today = U(y, m, day);
  switch (preset) {
    case "This Week": { const dow = today.getUTCDay() || 7; return { from: isoD(U(y, m, day - dow + 1)), to: isoD(today) }; }
    case "Last 7 Days": return { from: isoD(U(y, m, day - 6)), to: isoD(today) };
    case "This Month": return { from: isoD(U(y, m, 1)), to: isoD(today) };
    case "Last Month": return { from: isoD(U(y, m - 1, 1)), to: isoD(U(y, m, 0)) };
    case "Last 2 Months": return { from: isoD(U(y, m - 2, day)), to: isoD(today) };
    case "Last 3 Months": return { from: isoD(U(y, m - 3, day)), to: isoD(today) };
    case "YTD": return { from: isoD(U(y, 0, 1)), to: isoD(today) };
    case "Last Year": return { from: isoD(U(y - 1, 0, 1)), to: isoD(U(y - 1, 11, 31)) };
    default: return null; // Custom Dates
  }
}

/**
 * Return a copy of a widget spec with every moving part pinned to absolute
 * dates: the primary window, and the comparison window if one is enabled.
 * `datePreset` is rewritten to "Custom Dates" so nothing downstream — client or
 * server — is tempted to re-roll it.
 */
export function freezeSpec(spec, { comparisonRange, now = new Date() } = {}) {
  const out = { ...spec };
  const pr = resolvePreset(out.datePreset, now);
  if (pr) { out.dateFrom = pr.from; out.dateTo = pr.to; }

  if (out.compare && out.compare.enabled) {
    // Resolve relative comparison modes ("previous period" / "same period last
    // year") against the now-frozen primary window, then store them as custom.
    const range = typeof comparisonRange === "function" ? comparisonRange(out) : null;
    out.compare = range
      ? { ...out.compare, mode: "custom", dateFrom: range.from, dateTo: range.to }
      : { ...out.compare };
  }

  out.datePreset = "Custom Dates";
  out.frozenAt = new Date(now).toISOString();
  return out;
}
