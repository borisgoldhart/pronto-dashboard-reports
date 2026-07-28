/* Pronto Reporting Dashboard — Phase 2 frontend
 * Gridstack tiles + ECharts, backed by the /api/report proxy. */

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json();
  // Session expired mid-use (or never signed in): surface the login screen —
  // but never over the anonymous public share view.
  if (j && j.authRequired && !PUBLIC_VIEW) showLogin();
  return j;
};

let OPTIONS = null;              // enums for the editor
const widgets = new Map();       // id -> { id, el, chart, title, chartType, spec }
let grid = null;
let editingId = null;            // widget being edited (null => none)
let OFFICES = null;              // office name list (lazy loaded)
let officesLoading = false;
let officesPromise = null;       // shared in-flight load (prevents re-entrant reload loops)
let selectedOffices = [];        // offices chosen in the open editor
let dupOffices = [];             // offices chosen in the Duplicate-dashboard modal
let dupSourceGuid = null;        // dashboard being duplicated
let renGuid = null;              // dashboard being renamed (All-dashboards list)

// Upgrade old Phase-2 short keys to the real captured values, so the editor
// dropdowns match saved widgets (otherwise editing a saved widget shows blank
// selects and Apply submits empty values -> the graph fails).
const DS_ALIAS = { assets: "asset", timesheets: "timesheet_user_data", jobs: "job", usage: "user_history" };
const GB_ALIAS = { client_office: "client_office_name", master_client: "brandcat_name", author_office: "author_office_name", author: "author_name", job: "jobid" };
const IV_ALIAS = { day: "1DAY", week: "7DAYS", month: "1MONTH", quarter: "1MONTH", half: "1YEAR", year: "1YEAR" };
function normalizeSpec(s) {
  if (!s) return s;
  if (DS_ALIAS[s.dataSource]) s.dataSource = DS_ALIAS[s.dataSource];
  if (GB_ALIAS[s.groupBy]) s.groupBy = GB_ALIAS[s.groupBy];
  if (IV_ALIAS[s.interval]) s.interval = IV_ALIAS[s.interval];
  if (Array.isArray(s.filters)) s.filters.forEach((f) => { if (f && GB_ALIAS[f.name]) f.name = GB_ALIAS[f.name]; });
  return s;
}

// ---------- date label formatting ----------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtLabel(label, interval) {
  const d = new Date(label);
  if (isNaN(d)) return label;
  const m = MON[d.getUTCMonth()], y = d.getUTCFullYear();
  const iv = String(interval || "");
  if (iv === "1DAY" || iv === "7DAYS" || iv === "day" || iv === "week") return `${d.getUTCDate()} ${m}`;
  if (iv === "1YEAR" || iv === "year") return `${y}`;
  return `${m} ${y}`;
}
function valueLabel(spec) {
  if (spec.displayAs === "sum") return spec.statsField || "sum";
  return "count";
}

// ---------- chart types (icon buttons) ----------
// Single-dimension types collapse everything to one ring/series, so they can't use a
// sub-group or an interval — the UI disables those when one of these is chosen.
const SINGLE_DIM = new Set(["pie", "donut"]);
// These plot a period-over-period delta, so they require comparison to be switched on.
const COMPARE_TYPES = new Set(["diverging", "comparebar", "bubble"]);
// One value per group: no sub-group and no interval. Kept separate from SINGLE_DIM
// because SINGLE_DIM also selects the pie renderer, which a map must not use.
const NO_SUBGROUP = new Set(["pie", "donut", "map"]);
const CHART_TYPES = [
  { desc: "Grouped columns — one bar per series, side by side.", value: "bar", label: "Bar", icon: `<rect x="2" y="9" width="3" height="7"/><rect x="7" y="5" width="3" height="11"/><rect x="12" y="7" width="3" height="9"/>` },
  { desc: "Columns split into segments that add up to the total.", value: "stacked", label: "Stacked column", icon: `<rect x="3" y="10" width="5" height="6"/><rect x="3" y="5" width="5" height="4" opacity=".55"/><rect x="10" y="8" width="5" height="8"/><rect x="10" y="4" width="5" height="3" opacity=".55"/>` },
  { desc: "Grouped bars left-to-right. Good when category names are long.", value: "hbar", label: "Horizontal bar", icon: `<rect x="2" y="3" width="12" height="3"/><rect x="2" y="8" width="8" height="3"/><rect x="2" y="13" width="14" height="3"/>` },
  { desc: "Horizontal bars split into segments. Best for a group with many sub-values.", value: "hstacked", label: "Horizontal stacked", icon: `<rect x="2" y="3" width="7" height="3"/><rect x="9" y="3" width="6" height="3" opacity=".55"/><rect x="2" y="8" width="5" height="3"/><rect x="7" y="8" width="7" height="3" opacity=".55"/><rect x="2" y="13" width="9" height="3"/><rect x="11" y="13" width="5" height="3" opacity=".55"/>` },
  { desc: "Trend across the interval.", value: "line", label: "Line", icon: `<polyline points="2,13 6,8 10,10 16,3" fill="none" stroke="currentColor" stroke-width="2"/>` },
  { desc: "Stacked trend — shows how the mix changes over time.", value: "area", label: "Area", icon: `<polyline points="2,13 6,8 10,10 16,3" fill="none" stroke="currentColor" stroke-width="2"/><polygon points="2,13 6,8 10,10 16,3 16,16 2,16" opacity=".35"/>` },
  { desc: "Share of the total for a single dimension.", value: "pie", label: "Pie", icon: `<circle cx="9" cy="9" r="7"/><path d="M9 9 L9 2 A7 7 0 0 1 15 12 Z" opacity=".45" fill="#fff"/>` },
  { desc: "Share of the total, with a hollow centre.", value: "donut", label: "Donut", icon: `<path d="M9 2a7 7 0 1 1-.01 0Z"/><circle cx="9" cy="9" r="3.2" fill="#fff"/>` },
  { desc: "Percentage change per group, above and below zero.", value: "diverging", label: "Growth +/−", icon: `<rect x="9" y="2" width="7" height="3"/><rect x="9" y="7" width="4" height="3"/><rect x="4" y="12" width="5" height="3"/><rect x="8.4" y="1" width="1.2" height="16" opacity=".5"/>` },
  { desc: "Current period against the previous one, side by side.", value: "comparebar", label: "Period vs period", icon: `<rect x="2" y="3" width="13" height="2.6"/><rect x="2" y="6.2" width="8" height="2.6" opacity=".5"/><rect x="2" y="11" width="9" height="2.6"/><rect x="2" y="14.2" width="12" height="2.6" opacity=".5"/>` },
  { desc: "Values shaded onto a world map. Group By is restricted to country fields.", value: "map", label: "Map", icon: `<circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2 9h14" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9 2c2.2 2.2 2.2 11.8 0 14C6.8 13.8 6.8 4.2 9 2z" fill="none" stroke="currentColor" stroke-width="1.4"/>` },
  { desc: "Scale against growth — position and bubble size show size and change.", value: "bubble", label: "Size vs growth", icon: `<circle cx="5" cy="12" r="2.4"/><circle cx="10" cy="7" r="3.4" opacity=".65"/><circle cx="14.5" cy="4" r="1.8" opacity=".45"/>` },
];

// ---------- colour themes ----------
const THEMES = [
  { value: "board", label: "Board Report (red / black / grey)",
    colors: ["#D93B2B", "#1A1A1A", "#4D4D4D", "#7A7A7A", "#A6A6A6", "#C9C9C9", "#8C2A20", "#333333", "#666666", "#BFBFBF"] },
  { value: "pronto", label: "Pronto Blue",
    colors: ["#2ea3f2", "#1f6fb2", "#7fc6f7", "#12496f", "#57b5f5", "#0d3550", "#9fd6fa", "#3f8fd0", "#c7e8fd", "#1a2b38"] },
  { value: "growth", label: "Growth (green / red)",
    colors: ["#2E7D46", "#D93B2B", "#57A86B", "#E2705F", "#8CC79B", "#F0A093", "#1B5E2B", "#A32A1D", "#B9DFC3", "#F7CFC7"] },
  { value: "categorical", label: "Categorical (many series)",
    colors: ["#5470c6", "#91cc75", "#fac858", "#ee6666", "#73c0de", "#3ba272", "#fc8452", "#9a60b4", "#ea7ccc", "#c4ccd3"] },
  { value: "mono", label: "Monochrome grey",
    colors: ["#1A1A1A", "#3D3D3D", "#5C5C5C", "#7A7A7A", "#969696", "#B0B0B0", "#C7C7C7", "#DCDCDC", "#4F4F4F", "#8A8A8A"] },
  { value: "ocean", label: "Ocean",
    colors: ["#00587A", "#0E8B8B", "#3FB0AC", "#7FCDCD", "#173F5F", "#20639B", "#3CAEA3", "#96D5D1", "#0B2E3F", "#5FA8B8"] },
];
const themeColors = (id) => (THEMES.find((t) => t.value === id) || THEMES[0]).colors;

// ---------- world map ----------
// The map's region keys come from the GeoJSON itself, so we build the lookup from the
// file we actually loaded rather than from a hardcoded list that could drift from it.
// ISO code -> country name comes from the browser (Intl), so there's no table to maintain.
const WORLD_MAP_URL = "https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json";
let worldMapPromise = null;
let MAP_NAME_INDEX = null;                    // normalised name -> exact GeoJSON name

const normKey = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]/g, "");

// Natural Earth abbreviates some names; Intl spells them out. Only the divergences.
const NE_ALIAS = {
  unitedstatesofamerica: "United States", usa: "United States", us: "United States",
  unitedkingdomofgreatbritainandnorthernireland: "United Kingdom", uk: "United Kingdom",
  greatbritain: "United Kingdom", westernsahara: "W. Sahara",
  bosniaandherzegovina: "Bosnia and Herz.", dominicanrepublic: "Dominican Rep.",
  centralafricanrepublic: "Central African Rep.", equatorialguinea: "Eq. Guinea",
  southsudan: "S. Sudan", solomonislands: "Solomon Is.", czechia: "Czech Rep.",
  czechrepublic: "Czech Rep.", antiguaandbarbuda: "Antigua and Barb.",
  democraticrepublicofthecongo: "Dem. Rep. Congo", congokinshasa: "Dem. Rep. Congo",
  republicofthecongo: "Congo", congobrazzaville: "Congo",
  southkorea: "Korea", republicofkorea: "Korea",
  northkorea: "Dem. Rep. Korea", laos: "Lao PDR", russianfederation: "Russia",
  eswatini: "Swaziland", northmacedonia: "Macedonia", myanmar: "Myanmar", burma: "Myanmar",
  falklandislands: "Falkland Is.", faroeislands: "Faeroe Is.",
  frenchsouthernterritories: "Fr. S. Antarctic Lands", northernmarianaislands: "N. Mariana Is.",
  turksandcaicosislands: "Turks and Caicos Is.", britishvirginislands: "British Virgin Is.",
  usvirginislands: "U.S. Virgin Is.", marshallislands: "Marshall Is.",
  caymanislands: "Cayman Is.", cookislands: "Cook Is.", alandislands: "Aland",
  saintkittsandnevis: "St. Kitts and Nevis", saintvincentandthegrenadines: "St. Vin. and Gren.",
  turkiye: "Turkey",          // Intl now returns "Türkiye"; the map still says "Turkey"
};

/** Load + register the world map once. Rejects so the caller can show a real error. */
function ensureWorldMap() {
  if (!worldMapPromise) {
    worldMapPromise = fetch(WORLD_MAP_URL)
      .then((r) => { if (!r.ok) throw new Error(`map data HTTP ${r.status}`); return r.json(); })
      .then((geo) => {
        echarts.registerMap("world", geo);
        MAP_NAME_INDEX = new Map();
        (geo.features || []).forEach((f) => {
          const n = f?.properties?.name;
          if (n) MAP_NAME_INDEX.set(normKey(n), n);
        });
        return true;
      })
      .catch((e) => { worldMapPromise = null; throw e; });   // allow a retry
  }
  return worldMapPromise;
}

// ISO code -> English name, straight from the browser. No table to maintain.
let regionNames = null;
function isoToName(code) {
  try {
    if (!regionNames) regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    const out = regionNames.of(code);
    return out && out !== code ? out : null;      // .of() echoes the input when unknown
  } catch { return null; }
}

/** Resolve one of our data values to an exact GeoJSON region name, or null. */
function resolveMapCountry(raw) {
  if (!MAP_NAME_INDEX || raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lookup = (v) => (v ? MAP_NAME_INDEX.get(normKey(v)) : null);

  // 1. the value already matches a region name
  let hit = lookup(s);
  if (hit) return hit;
  // 2. it's an alias/spelled-out form of an abbreviated region name
  hit = lookup(NE_ALIAS[normKey(s)]);
  if (hit) return hit;
  // 3. it's an ISO code — expand via the browser, then retry both routes
  let expanded = null;
  if (/^[A-Za-z]{2,3}$/.test(s)) {
    expanded = isoToName(s.toUpperCase());
    hit = lookup(expanded) || lookup(NE_ALIAS[normKey(expanded || "")]);
    if (hit) return hit;
  }
  // 4. mechanical differences: Intl writes "Antigua & Barbuda" / "Myanmar (Burma)" where
  //    the map writes "Antigua and Barb." / "Myanmar". Strip the parenthetical and the
  //    joining "and", then allow the map's abbreviation as a PREFIX of the full name.
  // Strip "and"/"&" only as a STANDALONE word — a blanket replace would maul
  // Falkland, Thailand, Poland, Netherlands, Ireland, Iceland...
  const bareKey = (v) => normKey(String(v).replace(/\s*\(.*?\)/g, "").replace(/\s+(and|&)\s+/gi, " "));
  for (const cand of [s, expanded].filter(Boolean)) {
    const full = bareKey(cand);
    if (full.length < 6) continue;
    hit = MAP_NAME_INDEX.get(full);
    if (hit) return hit;
    // Allow the map's abbreviations ("Falkland Is." for "Falkland Islands") via a
    // complete-prefix match, but only when exactly one region qualifies — an ambiguous
    // match is a wrong answer, so prefer reporting it as unmatched.
    const cands = [];
    for (const [k, name] of MAP_NAME_INDEX) {
      const bare = bareKey(name);
      if (bare.length >= 6 && (full.startsWith(bare) || bare.startsWith(full))) cands.push(name);
    }
    if (cands.length === 1) return cands[0];
  }
  return null;
}

// ---------- ECharts option builder ----------
function buildOption(norm, chartType, spec, theme, width = 800) {
  const series = norm.series;
  const color = themeColors(theme);
  const money = (v) => (v == null ? "" : Number(v).toLocaleString());

  // ---- period-comparison charts (need norm.deltas from the second fetch) ----
  if (COMPARE_TYPES.has(chartType)) {
    const deltas = norm.deltas || [];
    if (!deltas.length) {
      return { color, title: { text: "No comparison data — the second period returned nothing", left: "center", top: "middle",
        textStyle: { fontSize: 13, color: "#6b7684", fontWeight: 500 } } };
    }
    const POS = color[0] === "#D93B2B" ? "#2E7D46" : color[0];   // green for growth
    const NEG = "#D93B2B";
    const pctTxt = (v) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + Math.round(v) + "%");
    const money = (v) => Number(v || 0).toLocaleString();

    if (chartType === "diverging") {
      // % change is undefined for groups with NOTHING in the previous period
      // (changePct === null). These were previously filtered out entirely, which
      // hid new-business wins (e.g. a brand's first jobs this year). They now
      // render at the TOP as "New" bars — pinned to the biggest mover's length,
      // same green at reduced opacity — instead of disappearing.
      const finite = deltas.filter((x) => x.changePct !== null).sort((a, b) => a.changePct - b.changePct);
      const fresh = deltas.filter((x) => x.changePct === null && x.current > 0)
                          .sort((a, b) => a.current - b.current);        // biggest new ends up topmost
      const d = [...finite, ...fresh];
      const pin = Math.max(100, ...finite.map((x) => Math.abs(x.changePct)));
      const names = d.map((x) => x.name);
      const lp = Math.min(210, Math.max(90, Math.round(Math.max(...names.map((n) => n.length), 0) * 6.2) + 16));
      return {
        color,
        grid: { left: lp, right: 62, top: 16, bottom: 28 },
        tooltip: { trigger: "item", confine: true, formatter: (p) => {
          const x = d[p.dataIndex];
          return `${escapeHtml(x.name)}<br/>${money(x.previous)} → <b>${money(x.current)}</b><br/>${x.changePct === null ? "New this period" : pctTxt(x.changePct)}`; } },
        xAxis: { type: "value", axisLabel: { formatter: (v) => v + "%" } },
        yAxis: { type: "category", data: names, axisLabel: { width: lp - 14, overflow: "truncate", ellipsis: "…" } },
        series: [{ type: "bar",
          data: d.map((x) => ({ value: x.changePct === null ? pin : x.changePct,
            itemStyle: { color: x.changePct === null || x.changePct >= 0 ? POS : NEG, opacity: x.changePct === null ? 0.55 : 1 } })),
          label: { show: true, position: "right", fontWeight: 600, color: "inherit",
            formatter: (p) => (d[p.dataIndex].changePct === null ? "New" : pctTxt(p.value)) } }],
      };
    }

    if (chartType === "comparebar") {
      const d = [...deltas].sort((a, b) => b.current - a.current);
      const names = d.map((x) => x.name);
      const lp = Math.min(210, Math.max(90, Math.round(Math.max(...names.map((n) => n.length), 0) * 6.2) + 16));
      return {
        color,
        grid: { left: lp, right: 24, top: 30, bottom: 28 },
        legend: { top: 0 },
        tooltip: { trigger: "item", confine: true,
          formatter: (p) => `${escapeHtml(p.seriesName)}<br/>${escapeHtml(String(p.name))}: <b>${money(p.value)}</b>` },
        xAxis: { type: "value", axisLabel: { formatter: (v) => (v >= 1000 ? v / 1000 + "k" : v) } },
        yAxis: { type: "category", data: names, inverse: true, axisLabel: { width: lp - 14, overflow: "truncate", ellipsis: "…" } },
        series: [
          { name: "Current", type: "bar", data: d.map((x) => x.current) },
          { name: "Previous", type: "bar", data: d.map((x) => x.previous) },
        ],
      };
    }

    // bubble: x = current size, y = % change, marker size scaled by current.
    // NEW groups (no previous-period data -> % undefined) plot at the top of the
    // y-range at reduced opacity instead of being dropped.
    const finiteB = deltas.filter((x) => x.changePct !== null && x.current > 0);
    const yCap = Math.max(100, ...finiteB.map((x) => Math.abs(x.changePct)));
    const d = [...finiteB, ...deltas.filter((x) => x.changePct === null && x.current > 0)
      .map((x) => ({ ...x, _new: true, changePct: yCap }))];
    const max = Math.max(...d.map((x) => x.current), 1);
    return {
      color,
      grid: { left: 64, right: 30, top: 26, bottom: 44 },
      tooltip: { trigger: "item", confine: true, formatter: (p) => {
        const x = p.data.d;
        return `${escapeHtml(x.name)}<br/>${money(x.previous)} → <b>${money(x.current)}</b><br/>${x._new ? "New this period" : pctTxt(x.changePct)}`; } },
      xAxis: { type: "value", name: "Size (current period)", nameLocation: "middle", nameGap: 26,
        axisLabel: { formatter: (v) => (v >= 1000 ? v / 1000 + "k" : v) } },
      yAxis: { type: "value", name: "% change", axisLabel: { formatter: (v) => v + "%" } },
      series: [{ type: "scatter",
        symbolSize: (val, p) => 8 + 30 * Math.sqrt((p.data.d.current || 0) / max),
        data: d.map((x) => ({ value: [x.current, x.changePct], name: x.name, d: x,
          itemStyle: { color: x.changePct >= 0 ? POS : NEG, opacity: x._new ? 0.45 : 0.75 } })),
        markLine: { silent: true, symbol: "none", lineStyle: { color: "#aaa", type: "dashed" },
          data: [{ yAxis: 0 }] },
        label: { show: true, position: "top", fontSize: 10, formatter: (p) => p.data.name } }],
    };
  }

  // Map: one value per country. Anything that can't be placed is reported on the chart
  // rather than silently dropped — a quietly incomplete map is worse than an ugly one.
  if (chartType === "map") {
    const totals = {};
    norm.intervals.forEach((iv) => iv.groups.forEach((g) => { totals[g.name] = (totals[g.name] || 0) + g.value; }));
    const byCountry = new Map();          // two source values can resolve to one country
    const unmatched = [];
    Object.entries(totals).forEach(([raw, value]) => {
      const name = resolveMapCountry(raw);
      if (name) byCountry.set(name, (byCountry.get(name) || 0) + value);
      else if (String(raw).trim()) unmatched.push([raw, value]);
    });
    const data = [...byCountry].map(([name, value]) => ({ name, value }));
    const max = Math.max(1, ...data.map((d) => d.value));
    // Codes like 99 aren't failures — they're records with no country (e.g. the Global
    // Resource Pool, a non-geographic office). Say that, rather than showing a raw code.
    const PLACEHOLDER = /^(99|0|zz|xx|n\/?a|none|null|unknown|-)$/i;
    const noCountry = unmatched.filter(([r]) => PLACEHOLDER.test(String(r).trim()));
    const unknown = unmatched.filter(([r]) => !PLACEHOLDER.test(String(r).trim()));
    const sum = (arr) => arr.reduce((a, [, v]) => a + v, 0);
    const bits = [];
    if (noCountry.length) bits.push(`${money(sum(noCountry))} with no country set`);
    if (unknown.length) bits.push(`${unknown.length} unrecognised (${unknown.slice(0, 3).map(([r]) => r).join(", ")}${unknown.length > 3 ? "…" : ""})`);
    const note = bits.join("  ·  ");
    const noteIsProblem = unknown.length > 0;   // a real mismatch, vs merely no country
    return {
      color,
      tooltip: { trigger: "item", confine: true,
        formatter: (p) => `${escapeHtml(p.name)}<br/><b>${p.value == null || isNaN(p.value) ? "no data" : money(p.value)}</b>` },
      visualMap: { min: 0, max, left: 8, bottom: 8, calculable: true,
        inRange: { color: ["#eef2f5", color[0]] }, textStyle: { fontSize: 10 } },
      ...(note ? { title: { subtext: note, left: "center", bottom: 4,
        subtextStyle: { fontSize: 10, color: noteIsProblem ? "#d64545" : "#8a929b",
                        width: 320, overflow: "truncate" } } } : {}),
      series: [{
        type: "map", map: "world", roam: true, nameProperty: "name",
        itemStyle: { areaColor: "#f5f7f9", borderColor: "#dfe4e9" },
        emphasis: { label: { show: false }, itemStyle: { areaColor: color[1] || "#999" } },
        data,
      }],
    };
  }

  // Pie / donut: one dimension only — collapse every interval into a single total per group.
  if (SINGLE_DIM.has(chartType)) {
    const totals = {};
    norm.intervals.forEach((iv) => iv.groups.forEach((g) => { totals[g.name] = (totals[g.name] || 0) + g.value; }));
    const data = series.map((n) => ({ name: n, value: totals[n] || 0 })).sort((a, b) => b.value - a.value);
    return {
      color,
      tooltip: { trigger: "item", confine: true, formatter: (p) => `${escapeHtml(p.name)}<br/><b>${money(p.value)}</b> (${p.percent}%)` },
      legend: { type: "scroll", orient: "vertical", right: 4, top: 8, bottom: 8 },
      series: [{
        type: "pie",
        radius: chartType === "donut" ? ["45%", "72%"] : "70%",
        center: ["38%", "52%"],
        data, label: { show: false }, minShowLabelAngle: 6,
      }],
    };
  }

  const horizontal = chartType === "hbar" || chartType === "hstacked";
  const cats = norm.intervals.map((iv) => fmtLabel(iv.label, spec.interval));
  const stacked = chartType === "stacked" || chartType === "area" || chartType === "hstacked";
  const s = series.map((name) => ({
    name,
    type: (chartType === "line" || chartType === "area") ? "line" : "bar",
    stack: stacked ? "total" : undefined,
    smooth: chartType === "line",
    areaStyle: chartType === "area" ? {} : undefined,
    emphasis: { focus: "series" },
    data: norm.intervals.map((iv) => { const g = iv.groups.find((x) => x.name === name); return g ? g.value : 0; }),
  }));

  const valueAxis = { type: "value", axisLabel: { formatter: (v) => (v >= 1000 ? (v / 1000) + "k" : v) } };
  // Horizontal charts put category names on the Y axis — size the left margin to the
  // longest label (capped) and truncate with an ellipsis so nothing runs off-canvas.
  const maxLabelLen = cats.reduce((m, c) => Math.max(m, String(c).length), 0);
  const leftPx = horizontal ? Math.min(210, Math.max(90, Math.round(maxLabelLen * 6.2) + 16)) : 64;
  // Vertical charts used to hide labels that would collide, which silently dropped most
  // of them once names got long. Instead work out how much room each category actually
  // has and rotate to fit, so every column stays labelled.
  // CHAR_PX is calibrated against a real render: "Havas Lynx New York (Agency)" (28ch)
  // measured ~221px at the default 12px axis font, i.e. ~7.9px/char, scaled to the 10px
  // font used here. The fit test uses the TRUE width — capping it first made long labels
  // look like they fit when they don't.
  const CHAR_PX = 6.8, MAX_LABEL_PX = 150, GAP_PX = 12;
  const trueLabelPx = maxLabelLen * CHAR_PX;
  const labelPx = Math.min(MAX_LABEL_PX, trueLabelPx);   // capped: only for truncation + height
  const perCatPx = Math.max(1, (width - leftPx - 18) / Math.max(1, cats.length));
  const rotateDeg = horizontal ? 0
    : trueLabelPx + GAP_PX <= perCatPx ? 0        // comfortably fits flat
      : trueLabelPx > perCatPx * 2.2 ? 90         // hopelessly tight -> vertical
        : 45;
  // Height the rotated text will occupy below the axis.
  const catLabelH = rotateDeg === 90 ? labelPx : rotateDeg === 45 ? labelPx * 0.71 : 0;
  const catAxis = {
    type: "category", data: cats, inverse: horizontal,
    axisLabel: horizontal
      ? { width: leftPx - 14, overflow: "truncate", ellipsis: "…" }
      : {
          interval: 0,                        // force one label per column
          rotate: rotateDeg,
          hideOverlap: false,
          fontSize: 10,
          width: MAX_LABEL_PX, overflow: "truncate", ellipsis: "…",
          align: rotateDeg ? "right" : "center",
          verticalAlign: rotateDeg ? "middle" : "top",
        },
  };

  // Density guard: grouped (non-stacked) bars draw one bar per series per category, so
  // categories × series bars share the tile height. Past ~40 they become hairlines —
  // show a scrollable window instead of squashing everything in.
  const barCount = (stacked ? 1 : s.length) * cats.length;
  const dense = s.length > 1 && barCount > 40;
  const visibleCats = Math.max(3, Math.floor(40 / Math.max(1, s.length)));
  const dataZoom = dense ? [
    { type: "inside", orient: horizontal ? "vertical" : "horizontal",
      yAxisIndex: horizontal ? 0 : undefined, xAxisIndex: horizontal ? undefined : 0,
      startValue: 0, endValue: visibleCats - 1, zoomLock: false },
    { type: "slider", orient: horizontal ? "vertical" : "horizontal",
      yAxisIndex: horizontal ? 0 : undefined, xAxisIndex: horizontal ? undefined : 0,
      startValue: 0, endValue: visibleCats - 1,
      width: horizontal ? 12 : undefined, height: horizontal ? undefined : 14,
      right: horizontal ? 4 : undefined, bottom: horizontal ? undefined : 4 },
  ] : undefined;

  return {
    color,
    ...(dataZoom ? { dataZoom } : {}),
    // item trigger => hovering a bar/line point shows ONLY that series, not the whole key
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p) => `${escapeHtml(p.seriesName)}<br/>${escapeHtml(String(p.name))}: <b>${money(p.value)}</b>`,
    },
    legend: { type: "scroll", top: 0 },
    grid: { left: leftPx, right: dense && horizontal ? 34 : 18, top: 34,
      bottom: (dense && !horizontal ? 46 : 30) + Math.round(catLabelH) },
    xAxis: horizontal ? valueAxis : catAxis,
    yAxis: horizontal ? catAxis : valueAxis,
    series: s,
  };
}

// ---------- widget tile ----------
function tileHTML(w) {
  return `
    <div class="grid-stack-item-content">
      <div class="w-head">
        <span class="w-title">${escapeHtml(w.title)}</span>
        <span class="w-info" aria-label="Report details">&#9432;<div class="w-info-pop"></div></span>
        <span class="w-cached"></span>
        <span class="spacer"></span>
        <span class="w-export">
          <button class="icon-btn" data-act="export" title="Export">⤓</button>
          <div class="export-menu">
            <div class="export-opt" data-exp="png">Export PNG</div>
            <div class="export-opt" data-exp="csv">Export CSV</div>
            <div class="export-opt" data-exp="json">Export JSON</div>
          </div>
        </span>
        ${PUBLIC_VIEW ? "" : '<button class="icon-btn" data-act="refresh" title="Refresh">⟳</button>'}
        ${CURRENT_DASH.canEdit && !PUBLIC_VIEW
          ? '<button class="icon-btn" data-act="copy" title="Duplicate this widget">⧉</button><button class="icon-btn" data-act="edit" title="Edit">✎</button><button class="icon-btn" data-act="remove" title="Remove">🗑</button>'
          : ""}
      </div>
      <div class="w-body"><div class="w-chart"></div><div class="w-msg"></div></div>
    </div>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- dashboard settings ----------
const REFRESH_OPTIONS = [
  { value: "0",   label: "Never — manual refresh only", ms: 0 },
  { value: "1h",  label: "Every hour",                  ms: 60 * 60 * 1000 },
  { value: "4h",  label: "Every 4 hours",               ms: 4 * 60 * 60 * 1000 },
  { value: "12h", label: "Every 12 hours",              ms: 12 * 60 * 60 * 1000 },
  { value: "24h", label: "Daily",                       ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Weekly",                      ms: 7 * 24 * 60 * 60 * 1000 },
];
let dashboardMeta = { title: "My Dashboard", refreshInterval: "0", lastRefreshedAt: null };
// The reporting API is permission-scoped, so data belongs to the identity that fetched
// it. We record that per widget (not per dashboard) — colleagues may have different access.
let CURRENT_USER = null;
const userLabel = (u) => (u && (u.name || u.email || (u.id && `user ${u.id}`))) || "unknown user";

/** Is the dashboard's data older than its configured refresh interval? */
function isStale(meta) {
  const opt = REFRESH_OPTIONS.find((o) => o.value === (meta.refreshInterval || "0"));
  if (!opt || !opt.ms) return false;                 // "Never"
  if (!meta.lastRefreshedAt) return true;            // never refreshed => refresh now
  const age = Date.now() - new Date(meta.lastRefreshedAt).getTime();
  return !isNaN(age) && age >= opt.ms;
}
function fmtWhen(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d)) return "never";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} day(s) ago`;
}

// ---------- date range presets ----------
const DATE_PRESETS = [
  "Custom Dates", "This Week", "Last 7 Days", "This Month", "Last Month",
  "Last 2 Months", "Last 3 Months", "YTD", "Last Year",
];
const isoD = (d) => d.toISOString().slice(0, 10);
/** Resolve a preset name to {from,to}; null for Custom Dates. */
function resolvePreset(preset) {
  const now = new Date();
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

// ---------- office SAYT filter ----------
function loadOffices() {
  if (OFFICES) return Promise.resolve(OFFICES);
  // One shared promise for concurrent callers — resolves only when the (slow)
  // offices fetch actually completes, so callers that `await`/`.then()` never
  // re-enter while it's still loading (that caused a tab-freezing loop).
  if (!officesPromise) {
    officesLoading = true;
    officesPromise = api("/api/report/offices")
      .then((r) => { OFFICES = (r && r.offices) || []; return OFFICES; })
      .catch(() => { OFFICES = []; return OFFICES; })
      .finally(() => { officesLoading = false; });
  }
  return officesPromise;
}
function renderOfficeChips() {
  $("officeChips").innerHTML = selectedOffices
    .map((o) => `<span class="chip">${escapeHtml(o)}<b data-rm="${escapeHtml(o)}" title="Remove">×</b></span>`)
    .join("");
}
function officeSearch() {
  const menu = $("officeMenu");
  const q = $("f_officeSearch").value.trim().toLowerCase();
  if (!OFFICES) {
    menu.innerHTML = `<div class="office-loading">Loading offices…</div>`;
    menu.classList.add("open");
    loadOffices().then(() => { if ($("drawer").classList.contains("open")) officeSearch(); });
    return;
  }
  const matches = (q ? OFFICES.filter((o) => o.toLowerCase().includes(q)) : OFFICES)
    .filter((o) => !selectedOffices.includes(o))
    .slice(0, 50);
  menu.innerHTML = matches.length
    ? matches.map((o) => `<div class="office-opt" data-office="${escapeHtml(o)}">${escapeHtml(o)}</div>`).join("")
    : `<div class="office-loading">${OFFICES.length ? "No matches" : "No offices available"}</div>`;
  menu.classList.add("open");
}
function initOfficePicker() {
  if (!$("f_officeSearch") || !$("officeMenu") || !$("officeChips")) return; // stale cached HTML — skip gracefully
  $("f_officeSearch").addEventListener("input", officeSearch);
  $("f_officeSearch").addEventListener("focus", officeSearch);
  $("f_officeSearch").addEventListener("blur", () => setTimeout(() => $("officeMenu").classList.remove("open"), 150));
  $("officeMenu").addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".office-opt");
    if (!opt) return;
    e.preventDefault();
    const o = opt.getAttribute("data-office");
    if (o && !selectedOffices.includes(o)) selectedOffices.push(o);
    $("f_officeSearch").value = "";
    renderOfficeChips();
    officeSearch();
  });
  $("officeChips").addEventListener("click", (e) => {
    const rm = e.target.getAttribute("data-rm");
    if (rm) { selectedOffices = selectedOffices.filter((x) => x !== rm); renderOfficeChips(); }
  });
}

// ---------- label lookups + summaries ----------
let DS_MAP, FIELD_MAP, IV_MAP;
function buildLabelMaps() {
  DS_MAP = new Map(OPTIONS.dataSources.map((o) => [o.value, o.label]));
  FIELD_MAP = new Map(OPTIONS.fields.map((o) => [o.value, o.label]));
  IV_MAP = new Map(OPTIONS.intervals.map((o) => [o.value, o.label]));
}
const dsLabel = (v) => (DS_MAP && DS_MAP.get(v)) || v || "";
const fieldLabel = (v) => (v ? (FIELD_MAP && FIELD_MAP.get(v)) || v : "");
const ivLabel = (v) => (IV_MAP && IV_MAP.get(v)) || v || "";
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function fmtDateShort(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || "");
  if (!m) return d || "";
  return `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}`;
}
function autoTitleFor(spec) {
  return `${dsLabel(spec.dataSource)} · ${fmtDateShort(spec.dateFrom)}–${fmtDateShort(spec.dateTo)}`;
}

// Fill the header ⓘ hover popover with the widget's query + any filters.
function updateInfo(w) {
  const pop = w.el.querySelector(".w-info-pop");
  const info = w.el.querySelector(".w-info");
  if (!pop) return;
  const s = w.spec || {};
  const filters = (s.filters || []).filter((f) => f && f.name);
  const offices = (s.officeFilters || []).filter(Boolean);
  const measure = s.displayAs === "count" || !s.displayAs
    ? "Count"
    : `${cap(s.displayAs)} of ${fieldLabel(s.statsField) || "—"}`;
  const hasSub = s.subGroup && s.subGroup !== "none";
  const rows = [
    ["Source", dsLabel(s.dataSource)],
    ["Group by", s.groupBy === "none" ? "No grouping" : fieldLabel(s.groupBy)],
    ...(hasSub ? [["Sub-group", fieldLabel(s.subGroup)]] : []),
    ["Interval", hasSub ? "n/a (sub-grouped)" : ivLabel(s.interval)],
    ["Measure", measure],
    ["Dates", `${fmtDateShort(s.dateFrom)} – ${fmtDateShort(s.dateTo)}`],
  ];
  let html = rows.map(([k, v]) => `<div class="ip-row"><span>${k}</span><b>${escapeHtml(v || "—")}</b></div>`).join("");
  html += `<div class="ip-sep"></div>`;
  const anyFilter = filters.length || offices.length;
  info.classList.toggle("has-filter", Boolean(anyFilter));
  if (offices.length) {
    html += `<div class="ip-flabel">Offices (${offices.length})</div>`;
    html += `<div class="ip-offices">${offices.map((o) => escapeHtml(o)).join(", ")}</div>`;
  }
  if (filters.length) {
    html += `<div class="ip-flabel">Filters (${filters.length})</div>`;
    html += filters.map((f) => `<div class="ip-row"><span>${escapeHtml(fieldLabel(f.name))}</span><b>${escapeHtml(f.value)}</b></div>`).join("");
  }
  if (!anyFilter) html += `<div class="ip-flabel">No filters applied</div>`;
  const cmp = s.compare || {};
  if (cmp.enabled && w.lastCompare) {
    html += `<div class="ip-sep"></div><div class="ip-flabel">Compared with</div>`;
    html += `<div class="ip-row"><span>${escapeHtml(({ "previous-year": "Same period last year", "previous-period": "Previous period", custom: "Custom" })[cmp.mode] || cmp.mode)}</span><b>${escapeHtml(fmtDateShort(w.lastCompare.dateFrom))} – ${escapeHtml(fmtDateShort(w.lastCompare.dateTo))}</b></div>`;
  }

  // Data provenance — the reporting API is permission-scoped, so record whose access
  // produced these numbers. This identity is also what a scheduled refresh re-runs as.
  const editor = w.lastEditedBy;
  const fetched = w.fetchedAs;
  html += `<div class="ip-sep"></div><div class="ip-flabel">Data access</div>`;
  html += `<div class="ip-row"><span>Last edited by</span><b>${escapeHtml(editor ? userLabel(editor) : "—")}</b></div>`;
  if (editor && editor.at) html += `<div class="ip-row"><span>Edited</span><b>${escapeHtml(fmtWhen(editor.at))}</b></div>`;
  html += `<div class="ip-row"><span>Data cached as</span><b>${escapeHtml(fetched ? userLabel(fetched) : "—")}</b></div>`;
  if (editor && fetched && editor.id && fetched.id && editor.id !== fetched.id) {
    html += `<div class="ip-warn">⚠ Cached under a different user than last edited it — values may reflect different permissions.</div>`;
  }

  // The exact API URL(s) this widget queries (populated after the first fetch).
  const urls = w.lastUrls && w.lastUrls.length ? w.lastUrls : (w.lastUrl ? [w.lastUrl] : []);
  if (urls.length) {
    html += `<div class="ip-sep"></div><div class="ip-flabel">API request${urls.length > 1 ? ` (${urls.length})` : ""}${w.lastChunked ? ` · ${w.lastChunked} chunks` : ""}${w.lastAuth ? " · auth: " + w.lastAuth : ""}${w.lastSeconds ? " · " + w.lastSeconds + "s" : ""}</div>`;
    html += urls.map((u) => `<a class="ip-url" href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`).join("");
  }
  pop.innerHTML = html;
}

// ---------- export ----------
function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = (s) => String(s || "chart").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);

function exportWidget(w, kind) {
  const base = safeName(w.title);
  const d = w.lastData; // { intervals, series }
  if (kind === "png") {
    if (!w.chart) return;
    const url = w.chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#fff" });
    const a = document.createElement("a"); a.href = url; a.download = `${base}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  if (!d) return;
  if (kind === "json") {
    download(`${base}.json`, JSON.stringify({ title: w.title, spec: w.spec, url: w.lastUrl, data: d }, null, 2), "application/json");
    return;
  }
  if (kind === "csv") {
    // rows = intervals, columns = series
    const cols = d.series || [];
    const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["Interval", ...cols].map(esc).join(",")];
    (d.intervals || []).forEach((iv) => {
      const byName = new Map((iv.groups || []).map((g) => [g.name, g.value]));
      lines.push([fmtLabel(iv.label, w.spec.interval), ...cols.map((c) => byName.get(c) ?? 0)].map(esc).join(","));
    });
    download(`${base}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
  }
}

function setMsg(w, text, isErr) {
  const el = w.el.querySelector(".w-msg");
  el.textContent = text || "";
  el.className = "w-msg" + (isErr ? " err" : "");
  el.style.display = text ? "flex" : "none";
  w.el.querySelector(".w-chart").style.visibility = text ? "hidden" : "visible";
}

function makeItemEl(w) {
  const el = document.createElement("div");
  el.className = "grid-stack-item";
  el.setAttribute("gs-id", w.id);
  el.setAttribute("gs-w", w.w ?? 6);
  el.setAttribute("gs-h", w.h ?? 4);
  if (w.x != null) el.setAttribute("gs-x", w.x);
  if (w.y != null) el.setAttribute("gs-y", w.y);
  el.innerHTML = tileHTML(w);
  // header buttons
  el.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.stopPropagation()); // don't start a drag
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = btn.getAttribute("data-act");
      const wid = widgets.get(w.id);
      if (act === "refresh") renderWidget(wid, { nocache: true });
      else if (act === "edit") openEditor(w.id);
      else if (act === "copy") duplicateWidget(w.id);
      else if (act === "remove") removeWidget(w.id);
      else if (act === "export") el.querySelector(".export-menu")?.classList.toggle("open");
    });
  });
  // export menu choices
  el.querySelectorAll(".export-opt").forEach((opt) => {
    opt.addEventListener("mousedown", (e) => e.stopPropagation());
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      exportWidget(widgets.get(w.id), opt.getAttribute("data-exp"));
      el.querySelector(".export-menu")?.classList.remove("open");
    });
  });
  return el;
}

async function renderWidget(w, { nocache = false } = {}) {
  updateInfo(w);
  setMsg(w, "Loading… (Pronto reports can take 10–30s the first time)");
  try {
    // dashboardId scopes the server cache to THIS dashboard (shared snapshot:
    // every viewer of the dashboard reads/warms the same partition).
    const res = await api(`/api/report/query${nocache ? "?nocache=1" : ""}`,
      { method: "POST", body: JSON.stringify({ ...w.spec, dashboardId: CURRENT_DASH.guid || undefined }) });
    // Record the exact request(s) for transparency (shown in the ⓘ hover).
    w.lastUrl = res.url; w.lastUrls = res.urls; w.lastAuth = res.authUsed; w.lastSeconds = res.seconds; w.lastChunked = res.chunked;
    w.fetchedAs = res.fetchedAs || null;
    w.lastCompare = res.compare || null;
    updateInfo(w);
    if (!res.ok) { setMsg(w, (res.error || "Query failed") + "\n\nRequest: " + (res.url || "(none)"), true); return; }
    setMsg(w, "");
    w.el.querySelector(".w-cached").textContent = res.cached ? "cached" : "";
    w.lastData = { intervals: res.intervals, series: res.series }; // for CSV/JSON export
    if (!res.intervals || res.intervals.length === 0) {
      setMsg(w, "No data returned for this query.\n\nRequest: " + (res.url || "(none)") + "\n(Hover ⓘ to inspect; click the URL to open it directly.)", false);
      return;
    }
    if (!w.chart) {
      const chartEl = w.el.querySelector(".w-chart");
      w.chart = echarts.init(chartEl);
      // Keep the chart sized to its tile through load, drag-resize, and window changes.
      w._ro = new ResizeObserver(() => { if (w.chart) w.chart.resize(); });
      w._ro.observe(chartEl);
    }
    if (w.chartType === "map") {
      // Registered once per session; a failure here is shown rather than leaving a blank tile.
      try { await ensureWorldMap(); }
      catch (e) { setMsg(w, "Could not load the world map data.\n" + String(e.message || e), true); return; }
    }
    w.chart.setOption(buildOption(res, w.chartType, w.spec, w.theme, w.chart.getWidth()), true);
    w.chart.resize();
  } catch (e) { setMsg(w, String(e), true); }
}

function addWidgetToGrid(w) {
  const el = makeItemEl(w);
  grid.addWidget(el);
  w.el = el;
  widgets.set(w.id, w);
  updateEmptyState();
  return w;
}

function removeWidget(id) {
  const w = widgets.get(id);
  if (!w) return;
  if (w._ro) w._ro.disconnect();
  if (w.chart) w.chart.dispose();
  grid.removeWidget(w.el);
  widgets.delete(id);
  updateEmptyState();
}

/** Duplicate a widget: clone its full spec into a new tile on this dashboard so
 *  users can build a dashboard quickly (tweak a data source, change a group-by,
 *  etc. on the copy rather than starting from scratch). The clone gets a fresh
 *  id and a deep copy of the spec (edits to one never affect the other), keeps
 *  the source's current on-screen size, and Gridstack auto-places it in a free
 *  slot. Like adding a widget, it isn't persisted until the user hits Save. */
function duplicateWidget(id) {
  const src = widgets.get(id);
  if (!src) return;
  const node = src.el?.gridstackNode || {};
  const clone = {
    id: "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    title: src.autoTitle ? src.title : `${src.title} (copy)`,
    autoTitle: src.autoTitle,
    chartType: src.chartType,
    theme: src.theme,
    spec: JSON.parse(JSON.stringify(src.spec || {})),   // deep copy — independent of the original
    lastEditedBy: CURRENT_USER ? { ...CURRENT_USER, at: new Date().toISOString() } : null,
    w: node.w ?? src.w ?? 6,
    h: node.h ?? src.h ?? 4,
    // no x/y -> Gridstack drops it into the first free slot (no overlap)
  };
  const w = addWidgetToGrid(clone);
  renderWidget(w);
}

function updateEmptyState() {
  $("emptyState").style.display = widgets.size ? "none" : "block";
}

// ---------- editor drawer ----------
function fillSelect(sel, items, valueKey = "value", labelKey = "label") {
  sel.innerHTML = items.map((it) => `<option value="${it[valueKey]}">${escapeHtml(it[labelKey])}</option>`).join("");
}

// ---------- field pickers (search-as-you-type over the 93 captured fields) ----------
// 93 fields is too many to scan in a dropdown, but the long tail is occasionally needed.
// So: type to search everything, and with an empty box show the handful actually used.
// Values verified against server/fields.js — do not hand-write these.
const FAVOURITE_FIELDS = [
  "brand_name",                // Brand Name
  "brandcat_name",             // Brand Category Name
  "client_office_name",        // Job Office Name
  "author_name",               // User Name
  "job_airing_country_name",   // Job Airing Country
  "ticket_status_name",        // Task Status
  "job_title",                 // Project Name
  "client_office_country_iso", // Job Office Country
  "author_office_name",        // User Office Name
  "job_status",                // Job Status
];

// Country fields offered when the Map chart is selected. Deliberately a short curated
// list, not a search: users shouldn't need to know a field name to plot a map.
//
// NOTE: the legacy dropdown lists client_office_country_iso TWICE — as "Job Office
// Country ISO" and again as "User Office Country Iso" — but both send
// facet_field=client_office_country_iso, so they are the same data. Listing both would
// give two options that render identical maps. (Same quirk as job_airing_country_name
// and job_extension; see docs/legacy-report-fields.md.)
const MAP_FIELDS = ["client_office_country_iso"];
const DEFAULT_MAP_FIELD = "client_office_country_iso";   // Job Office Country
const FIELD_LABEL = new Map();   // value -> label, for showing the current selection

/** Wire a SAYT input to a hidden <select> that stays the source of truth, so the rest
 *  of the editor (readSpec / openEditor / the interval lock) needs no changes. */
function initFieldPicker(key, noneLabel) {
  const input = $(`f_${key}Search`), menu = $(`${key}Menu`), sel = $(`f_${key}`);
  if (!input || !menu || !sel) return;                 // stale cached HTML — skip gracefully
  const NONE = { value: "none", label: noneLabel };
  let active = -1, shown = [];

  const matches = (q) => {
    // With Map selected, Group By offers only country fields (and never "no grouping",
    // which would leave nothing to place on the map).
    const mapMode = key === "groupBy" && selectedChartType === "map";
    const pool = mapMode ? OPTIONS.fields.filter((f) => MAP_FIELDS.includes(f.value)) : OPTIONS.fields;
    const head = mapMode ? [] : [NONE];
    if (!q) {
      const defaults = mapMode ? pool
        : FAVOURITE_FIELDS.map((v) => OPTIONS.fields.find((f) => f.value === v)).filter(Boolean);
      return [...head, ...defaults];
    }
    // Match on the friendly label AND the raw field name — power users search either.
    return [...head, ...pool].filter((f) =>
      f.label.toLowerCase().includes(q) || f.value.toLowerCase().includes(q));
  };

  function render() {
    const q = input.value.trim().toLowerCase();
    shown = matches(q);
    active = -1;
    const head = q
      ? `<div class="sayt-head">${shown.length} match${shown.length === 1 ? "" : "es"}</div>`
      : (key === "groupBy" && selectedChartType === "map"
          ? `<div class="sayt-head">Country field</div>`
          : `<div class="sayt-head">Commonly used — type to search all ${OPTIONS.fields.length}</div>`);
    menu.innerHTML = head + (shown.length
      ? shown.map((f, i) => `<div class="sayt-opt${f.value === sel.value ? " sel" : ""}" data-i="${i}">
           <span>${escapeHtml(f.label)}</span>${f.value === "none" ? "" : `<code>${escapeHtml(f.value)}</code>`}</div>`).join("")
      : `<div class="sayt-empty">No field matches that.</div>`);
    menu.classList.add("open");
  }

  function choose(i) {
    const f = shown[i];
    if (!f) return;
    sel.value = f.value;
    sel.dispatchEvent(new Event("change"));   // reuse the existing select listeners
    syncFieldPicker(key);
    menu.classList.remove("open");
    input.blur();
  }

  input.addEventListener("input", render);
  // Focusing clears the box so the curated/default list shows straight away — the user
  // shouldn't have to know a field name to pick one. Blur restores the current selection.
  input.addEventListener("focus", () => { input.value = ""; render(); });
  input.addEventListener("blur", () => setTimeout(() => { menu.classList.remove("open"); syncFieldPicker(key); }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { menu.classList.remove("open"); input.blur(); return; }
    if (!menu.classList.contains("open")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      [...menu.querySelectorAll(".sayt-opt")].forEach((el, i) => el.classList.toggle("active", i === active));
      menu.querySelector(".sayt-opt.active")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active >= 0 ? active : 0);       // Enter with no arrowing takes the top match
    }
  });
  menu.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".sayt-opt");
    if (opt) { e.preventDefault(); choose(Number(opt.getAttribute("data-i"))); }
  });
}

/** Push the hidden select's value into the visible search box. */
function syncFieldPicker(key) {
  const input = $(`f_${key}Search`), sel = $(`f_${key}`);
  if (!input || !sel) return;
  input.value = sel.value && sel.value !== "none" ? (FIELD_LABEL.get(sel.value) || sel.value) : "";
  const mapMode = key === "groupBy" && selectedChartType === "map";
  input.placeholder = mapMode ? "Country field"
    : (sel.value === "none" || !sel.value)
      ? (key === "groupBy" ? "No grouping (totals only)" : "No sub-group")
      : "Search fields…";
}
const syncFieldPickers = () => { syncFieldPicker("groupBy"); syncFieldPicker("subGroup"); };

// ---------- filters (repeatable) ----------
const DEFAULT_LIMIT = 10;
const MAP_LIMIT = 200;          // countries: effectively "no cap"

function filterFieldOptions(selected) {
  return `<option value="">— select field —</option>` + OPTIONS.fields
    .map((f) => `<option value="${f.value}"${f.value === selected ? " selected" : ""}>${escapeHtml(f.label)}</option>`)
    .join("");
}

function filterRowHtml(f = { name: "", value: "" }) {
  return `<div class="filter-row">
    <select class="ff-name">${filterFieldOptions(f.name)}</select>
    <input class="ff-value" type="text" value="${escapeHtml(f.value || "")}" placeholder="exact value" />
    <button type="button" class="ff-clear" title="Remove this filter">✕</button>
  </div>`;
}

/** Paint the filter rows from a spec's filters array. */
function renderFilterRows(filters) {
  const rows = (filters || []).filter((f) => f && (f.name || f.value));
  $("filterRows").innerHTML = rows.length
    ? rows.map(filterRowHtml).join("")
    : `<div class="filter-empty">No filters — the report covers everything in range.</div>`;
}

/** Collect the filter rows back into a spec array (blank rows dropped). */
function readFilterRows() {
  return [...document.querySelectorAll("#filterRows .filter-row")]
    .map((row) => ({ name: row.querySelector(".ff-name").value,
                     value: row.querySelector(".ff-value").value.trim() }))
    .filter((f) => f.name && f.value);
}

function initFilterUi() {
  $("addFilterBtn").addEventListener("click", () => {
    const empty = $("filterRows").querySelector(".filter-empty");
    if (empty) empty.remove();
    $("filterRows").insertAdjacentHTML("beforeend", filterRowHtml());
  });
  $("clearFiltersBtn").addEventListener("click", () => renderFilterRows([]));
  // one delegated handler covers rows added later
  $("filterRows").addEventListener("click", (e) => {
    const btn = e.target.closest(".ff-clear");
    if (!btn) return;
    btn.closest(".filter-row").remove();
    if (!$("filterRows").querySelector(".filter-row")) renderFilterRows([]);
  });
}

function initEditorOptions() {
  fillSelect($("f_dataSource"), OPTIONS.dataSources);
  // Group By: allow "no grouping" (ungrouped totals) plus the full field list
  $("f_groupBy").innerHTML = `<option value="none">— No grouping (totals only) —</option>` +
    OPTIONS.fields.map((f) => `<option value="${f.value}">${escapeHtml(f.label)}</option>`).join("");
  $("f_subGroup").innerHTML = `<option value="none">— No sub-group —</option>` +
    OPTIONS.fields.map((f) => `<option value="${f.value}">${escapeHtml(f.label)}</option>`).join("");
  OPTIONS.fields.forEach((f) => FIELD_LABEL.set(f.value, f.label));
  initFieldPicker("groupBy", "— No grouping (totals only) —");
  initFieldPicker("subGroup", "— No sub-group —");
  fillSelect($("f_interval"), OPTIONS.intervals);
  fillSelect($("f_displayAs"), OPTIONS.displayAs);
  $("f_datePreset").innerHTML = DATE_PRESETS.map((p) => `<option value="${p}">${p}</option>`).join("");
  $("f_theme").innerHTML = THEMES.map((t) => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join("");
  renderChartTypes();
  $("chartTypes").addEventListener("click", (e) => {
    const btn = e.target.closest(".ct-btn");
    if (btn) setChartType(btn.getAttribute("data-ct"));
  });

  // The API honours EITHER an interval OR a sub-group, never both (verified). So a
  // sub-group forces "No interval" and locks the interval picker.
  $("f_subGroup").addEventListener("change", syncSubGroup);
  $("f_interval").addEventListener("change", syncSubGroup);
  $("f_subGroupMode").addEventListener("change", syncSubGroup);
  $("f_compareMode").addEventListener("change", syncCompare);
  initFilterUi();
  $("f_displayAs").addEventListener("change", syncStatsFieldVisibility);

  // Date preset -> fill the from/to inputs (Custom leaves them editable)
  $("f_datePreset").addEventListener("change", () => {
    const r = resolvePreset($("f_datePreset").value);
    const custom = !r;
    $("f_dateFrom").disabled = !custom;
    $("f_dateTo").disabled = !custom;
    if (r) { $("f_dateFrom").value = r.from; $("f_dateTo").value = r.to; }
  });

  // Data source -> default measure (Timesheet = sum of hours, everything else = count)
  $("f_dataSource").addEventListener("change", () => {
    const ds = OPTIONS.dataSources.find((d) => d.value === $("f_dataSource").value);
    const wantSum = $("f_dataSource").value === "timesheet_user_data";
    $("f_displayAs").value = wantSum ? "sum" : "count";
    $("f_statsField").value = wantSum ? (ds?.defaultStatsField || "hours") : "";
    syncStatsFieldVisibility();
  });
}
// ---------- chart type buttons ----------
let selectedChartType = "stacked";
function renderChartTypes() {
  $("chartTypes").innerHTML = CHART_TYPES.map((t) => {
    // Availability is derived from the same sets the editor enforces, so the hover can
    // never drift from what the controls actually do.
    const single = NO_SUBGROUP.has(t.value);
    const cmp = COMPARE_TYPES.has(t.value);
    const opts = [
      ["Sub-group", !single && !cmp],
      ["Interval", !single && !cmp],
      ["Comparison period", cmp],
    ];
    const optHtml = opts.map(([name, ok]) =>
      `<span class="ct-opt ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${name}</span>`).join("");
    return `
    <button type="button" class="ct-btn${t.value === selectedChartType ? " active" : ""}" data-ct="${t.value}">
      <svg viewBox="0 0 18 18" width="20" height="20" fill="currentColor">${t.icon}</svg>
      <span>${t.label}</span>
      <div class="ct-pop">
        <b>${escapeHtml(t.label)}</b>
        <p>${escapeHtml(t.desc || "")}</p>
        <div class="ct-opts">${optHtml}</div>
      </div>
    </button>`;
  }).join("");
}
function setChartType(v) {
  selectedChartType = v;
  renderChartTypes();
  syncChartTypeConstraints();
}
let preservedInterval = null;
let preservedLimit = null, preservedOther = null;   // restored when leaving the Map type
/** Interval is unavailable for pie/donut, for comparison charts (they total the whole
 *  period), and when a sub-group is set (the API honours one or the other). Centralised
 *  so the chart-type and sub-group rules can't fight — and it restores the user's
 *  previous choice when the interval becomes available again. */
function applyIntervalLock() {
  const t = selectedChartType;
  const hasSub = $("f_subGroup").value && $("f_subGroup").value !== "none";
  const lock = NO_SUBGROUP.has(t) || COMPARE_TYPES.has(t) || hasSub;
  const el = $("f_interval");
  if (lock) {
    if (!el.disabled && el.value !== "0") preservedInterval = el.value;  // remember before forcing
    el.value = "0";
    el.disabled = true;
  } else {
    el.disabled = false;
    if (preservedInterval) { el.value = preservedInterval; preservedInterval = null; }
  }
  // Hidden rather than greyed out — an unusable control is just noise. Display As
  // takes the full width while Interval is away.
  $("intervalWrap").style.display = lock ? "none" : "";
  $("intervalRow").classList.toggle("one", lock);
}

/** Compare-period controls: show options when enabled, custom dates when chosen. */
function syncCompare() {
  const on = COMPARE_TYPES.has(selectedChartType);
  $("compareCustom").style.display = (on && $("f_compareMode").value === "custom") ? "grid" : "none";
  $("compareHint").textContent = on
    ? "Runs the same query over a second period and charts the change. Both periods are cached."
    : "";
}

/** Chart-type constraints.
 *  • pie/donut  — single dimension: no sub-group, no interval
 *  • comparison — totals each group over the whole period and compares it with another,
 *                 so a sub-group has nothing to nest into (it would flatten to sub-group
 *                 totals and lose the group). Interval is irrelevant for the same reason. */
function syncChartTypeConstraints() {
  const single = NO_SUBGROUP.has(selectedChartType);
  const isCompare = COMPARE_TYPES.has(selectedChartType);

  // The comparison period only applies to the chart types that plot a delta.
  $("compareBox").style.display = isCompare ? "block" : "none";

  const noSub = single || isCompare;
  if (noSub) { $("f_subGroup").value = "none"; $("f_subGroup").disabled = true; }
  else { $("f_subGroup").disabled = false; }
  // Hide the section entirely rather than showing a dead control; the chart-type
  // hover already explains which types support sub-grouping.
  $("subGroupBox").style.display = noSub ? "none" : "";
  syncFieldPicker("subGroup");

  // A map can only plot a country, so Group By is constrained to the geo fields.
  const isMap = selectedChartType === "map";
  if (isMap && !MAP_FIELDS.includes($("f_groupBy").value)) {
    $("f_groupBy").value = DEFAULT_MAP_FIELD;
    $("f_groupBy").dispatchEvent(new Event("change"));
  }
  syncFieldPicker("groupBy");

  // Maps want every country, and an "Other" bucket has nowhere to go on a map. Stash the
  // user's settings so switching away restores what they had.
  if (isMap) {
    if (preservedLimit === null) {
      preservedLimit = $("f_limit").value;
      preservedOther = $("f_showOther").checked;
    }
    $("f_limit").value = MAP_LIMIT;
    $("f_showOther").checked = false;
  } else if (preservedLimit !== null) {
    $("f_limit").value = preservedLimit;
    $("f_showOther").checked = preservedOther;
    preservedLimit = null; preservedOther = null;
  }
  $("f_showOther").closest("label").style.display = isMap ? "none" : "";


  syncCompare();
  syncSubGroup();
}

/** Sub-group and interval are mutually exclusive in the API — keep the UI honest. */
function syncSubGroup() {
  const hasSubNow = $("f_subGroup").value && $("f_subGroup").value !== "none";
  $("subGroupLimitWrap").style.display = hasSubNow ? "block" : "none";
  $("subGroupModeWrap").style.display = hasSubNow ? "block" : "none";
  if (hasSubNow) {
    // Only warn about the one combination that actually looks broken: grouped bars
    // reserve a slot per series per category, so a per-group series set leaves gaps.
    const groupedBars = selectedChartType === "bar" || selectedChartType === "hbar";
    const perGroup = $("f_subGroupMode").value === "per-group";
    $("subGroupModeHint").textContent = (groupedBars && perGroup)
      ? "⚠ Grouped bars leave blank gaps where a group has no value for a series. Use “Consistent across groups”, or a stacked chart type."
      : "";
  } else {
    $("subGroupModeHint").textContent = "";
  }
  applyIntervalLock();
}

function syncStatsFieldVisibility() {
  $("statsFieldWrap").style.display = $("f_displayAs").value === "sum" ? "block" : "none";
}

function defaultSpec() {
  // Rolling last 2 months, weekly interval — small/fast for testing.
  const iso = (d) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 2);
  return {
    dataSource: "asset", groupBy: "client_office_name", interval: "7DAYS",
    displayAs: "count", statsField: "", datePreset: "Last 2 Months",
    dateFrom: iso(from), dateTo: iso(to),
    limit: 10, subGroupLimit: 6, subGroupMode: "per-group", showOther: true,
    compare: { enabled: false, mode: "previous-year", dateFrom: "", dateTo: "" },
    filters: [], officeFilters: [],
  };
}

function openEditor(id) {
  editingId = id;
  // The interval preserve/restore state belongs to one editing session. Without this
  // reset, an interval stashed while configuring the *previous* widget gets restored
  // over this widget's saved interval the moment the lock lifts.
  preservedInterval = null;
  preservedLimit = null; preservedOther = null;
  $("f_interval").disabled = false;
  const w = id ? widgets.get(id) : { title: "New graph", chartType: "stacked", spec: defaultSpec() };
  if (w.spec) normalizeSpec(w.spec);
  $("drawerTitle").textContent = id ? "Edit graph" : "New graph";
  // Leave title blank when it's auto-generated, so the placeholder invites a custom one
  // and it keeps auto-updating from the data source + dates.
  $("f_title").value = (id && !w.autoTitle) ? w.title : "";
  $("f_dataSource").value = w.spec.dataSource;
  $("f_groupBy").value = w.spec.groupBy;
  $("f_subGroup").value = w.spec.subGroup || "none";
  $("f_interval").value = w.spec.interval;
  $("f_displayAs").value = w.spec.displayAs;
  $("f_statsField").value = w.spec.statsField || "";
  selectedChartType = w.chartType || "stacked";
  renderChartTypes();
  $("f_theme").value = w.theme || "board";
  const preset = w.spec.datePreset || "Custom Dates";
  $("f_datePreset").value = DATE_PRESETS.includes(preset) ? preset : "Custom Dates";
  const isCustom = !resolvePreset($("f_datePreset").value);
  $("f_dateFrom").disabled = !isCustom;
  $("f_dateTo").disabled = !isCustom;
  $("f_dateFrom").value = w.spec.dateFrom;
  $("f_dateTo").value = w.spec.dateTo;
  $("f_limit").value = w.spec.limit;
  $("f_subGroupLimit").value = w.spec.subGroupLimit ?? 6;
  $("f_subGroupMode").value = w.spec.subGroupMode || "per-group";
  $("f_showOther").checked = Boolean(w.spec.showOther);
  const cmp = w.spec.compare || {};
  $("f_compareMode").value = cmp.mode || "previous-year";
  $("f_compareFrom").value = cmp.dateFrom || "";
  $("f_compareTo").value = cmp.dateTo || "";
  renderFilterRows(w.spec.filters);
  // offices
  selectedOffices = [...(w.spec.officeFilters || [])];
  $("f_officeSearch").value = "";
  $("officeMenu").classList.remove("open");
  renderOfficeChips();
  loadOffices();
  syncStatsFieldVisibility();
  syncChartTypeConstraints();
  syncFieldPickers();          // show the saved field names in the search boxes
  $("drawer").classList.add("open");
  $("scrim").classList.add("open");
}
function closeEditor() {
  editingId = null;
  $("drawer").classList.remove("open");
  $("scrim").classList.remove("open");
}

function applyEditor() {
  const spec = {
    dataSource: $("f_dataSource").value,
    groupBy: $("f_groupBy").value,
    subGroup: $("f_subGroup").value,
    interval: $("f_interval").value,
    displayAs: $("f_displayAs").value,
    statsField: $("f_statsField").value || undefined,
    dateFrom: $("f_dateFrom").value,
    dateTo: $("f_dateTo").value,
    limit: Number($("f_limit").value) || DEFAULT_LIMIT,
    subGroupLimit: Number($("f_subGroupLimit").value) || 0,
    subGroupMode: $("f_subGroupMode").value,
    compare: {
      enabled: COMPARE_TYPES.has(selectedChartType),   // implied by the chart type
      mode: $("f_compareMode").value,
      dateFrom: $("f_compareFrom").value,
      dateTo: $("f_compareTo").value,
    },
    showOther: $("f_showOther").checked,
    datePreset: $("f_datePreset").value,
    filters: [],
    officeFilters: [...selectedOffices],
  };
  // A preset always wins over the (disabled) date inputs, so it stays rolling.
  const pr = resolvePreset(spec.datePreset);
  if (pr) { spec.dateFrom = pr.from; spec.dateTo = pr.to; }
  spec.filters = readFilterRows();

  // Safety net: never submit an empty required field (would fail the query).
  if (!spec.dataSource) spec.dataSource = OPTIONS.dataSources[0].value;
  if (!spec.groupBy) spec.groupBy = OPTIONS.fields[0].value;
  if (!spec.interval) spec.interval = "1MONTH";

  // No title typed -> auto-title from data source + date range (kept in sync on edits).
  const typed = $("f_title").value.trim();
  const autoTitle = !typed;
  const title = autoTitle ? autoTitleFor(spec) : typed;
  const chartType = selectedChartType;
  const theme = $("f_theme").value;

  if (editingId) {
    const w = widgets.get(editingId);
    w.title = title; w.chartType = chartType; w.theme = theme; w.spec = spec; w.autoTitle = autoTitle;
    w.lastEditedBy = CURRENT_USER ? { ...CURRENT_USER, at: new Date().toISOString() } : null;
    w.el.querySelector(".w-title").textContent = title;
    renderWidget(w);
  } else {
    const w = addWidgetToGrid({ id: "w" + Date.now().toString(36), title, chartType, theme, spec, autoTitle,
      lastEditedBy: CURRENT_USER ? { ...CURRENT_USER, at: new Date().toISOString() } : null, w: 6, h: 4 });
    renderWidget(w);
  }
  closeEditor();
}

// ---------- persistence ----------
function currentLayout() {
  const saved = grid.save(false); // [{x,y,w,h,id}]
  const byId = new Map(saved.map((n) => [String(n.id), n]));
  return [...widgets.values()].map((w) => {
    const n = byId.get(String(w.id)) || {};
    return { id: w.id, x: n.x, y: n.y, w: n.w, h: n.h, title: w.title, autoTitle: w.autoTitle, chartType: w.chartType, theme: w.theme, lastEditedBy: w.lastEditedBy, spec: w.spec };
  });
}
// ---------- dashboard settings modal ----------
function openDashSettings() {
  $("d_refresh").innerHTML = REFRESH_OPTIONS.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");
  $("d_name").value = dashboardMeta.title || "";
  $("d_refresh").value = dashboardMeta.refreshInterval || "0";
  $("d_lastRefreshed").textContent = `Data last refreshed: ${fmtWhen(dashboardMeta.lastRefreshedAt)}.`;
  $("d_nameErr").textContent = "";
  $("dashModal").classList.add("open");
  $("dashModalScrim").classList.add("open");
  setTimeout(() => $("d_name").focus(), 50);
}
function closeDashSettings() {
  $("dashModal").classList.remove("open");
  $("dashModalScrim").classList.remove("open");
}

async function saveDashboard() {
  const name = $("d_name").value.trim();
  if (!name) { $("d_nameErr").textContent = "Please give the dashboard a name."; $("d_name").focus(); return; }

  dashboardMeta.title = name;
  dashboardMeta.refreshInterval = $("d_refresh").value;
  setCrumb(name);
  closeDashSettings();

  $("status").textContent = "saving…";
  const body = {
    title: name,
    refreshInterval: dashboardMeta.refreshInterval,
    widgets: currentLayout(),
  };
  const res = await api(`/api/dashboard/${CURRENT_DASH.guid}`, { method: "PUT", body: JSON.stringify(body) });
  $("status").textContent = res.updatedAt ? "saved ✓" : (res.error || "save failed");
  setTimeout(() => ($("status").textContent = ""), 3000);
}

/* ---- multi-dashboard: routing, create, list, share, read-only ---- */
let CURRENT_DASH = { guid: null, canEdit: true, createdBy: null };
let PUBLIC_VIEW = false;   // shared link opened without a session: cached data only

/** Banner breadcrumb: "Reporting Dashboards / <current dashboard>". */
function setCrumb(name) {
  window.ProntoPage = window.ProntoPage || {};
  window.ProntoPage.breadcrumb = name ? ["Reporting Dashboards", name] : ["Reporting Dashboards"];
  document.querySelector("pronto-banner")?.refresh();
}

function applyEditMode() {
  // Strict view-only for share-link visitors (non-creators): no Add widget,
  // Share, Save — and no Dashboards list. Just the report + per-widget refresh.
  const ro = !CURRENT_DASH.canEdit;
  ["addBtn", "saveBtn", "shareBtn", "dashListBtn"].forEach((id) => {
    const el = $(id); if (el) el.style.display = ro ? "none" : "";
  });
  const badge = $("roBadge");
  if (badge) {
    badge.hidden = !ro;
    const by = CURRENT_DASH.createdBy && (CURRENT_DASH.createdBy.name || CURRENT_DASH.createdBy.email);
    badge.textContent = "View only" + (by ? " — created by " + by : "");
  }
  try { grid.setStatic(ro); } catch {}
}

function openCreateDash() {
  $("c_name").value = ""; $("c_nameErr").textContent = "";
  $("createModal").classList.add("open"); $("createScrim").classList.add("open");
  setTimeout(() => $("c_name").focus(), 50);
}
function closeCreateDash() {
  $("createModal").classList.remove("open"); $("createScrim").classList.remove("open");
}
async function createDashboard() {
  const title = $("c_name").value.trim();
  if (!title) { $("c_nameErr").textContent = "Give the dashboard a name."; return; }
  const r = await api("/api/dashboards", { method: "POST", body: JSON.stringify({ title }) });
  if (r && r.guid) { location.href = "/?d=" + r.guid; return; }
  $("c_nameErr").textContent = (r && r.error) || "Could not create the dashboard.";
}

/* ---------- Rename dashboard (from the list view) ----------
   Saves just the title via PUT (widgets are left untouched server-side). */
function openRenameModal(guid, title) {
  renGuid = guid;
  $("ren_name").value = title || "";
  $("ren_nameErr").textContent = "";
  $("renModal").classList.add("open"); $("renScrim").classList.add("open");
  setTimeout(() => { $("ren_name").focus(); $("ren_name").select(); }, 30);
}
function closeRenameModal() {
  $("renModal").classList.remove("open"); $("renScrim").classList.remove("open");
}
async function submitRename() {
  const title = $("ren_name").value.trim();
  if (!title) { $("ren_nameErr").textContent = "Enter a name."; return; }
  const btn = $("ren_save"); btn.disabled = true; const lbl = btn.textContent; btn.textContent = "Saving…";
  try {
    const r = await api("/api/dashboard/" + renGuid, { method: "PUT", body: JSON.stringify({ title }) });
    if (!r || !r.ok) { $("ren_nameErr").textContent = (r && r.error) || "Rename failed."; return; }
    const row = $("dashRows").querySelector(`tr[data-guid="${window.CSS && CSS.escape ? CSS.escape(renGuid) : renGuid}"]`);
    if (row) { row.setAttribute("data-title", title); const n = row.querySelector(".dash-name"); if (n) n.textContent = title; }
    closeRenameModal();
  } catch (e) { $("ren_nameErr").textContent = String(e.message || e); }
  finally { btn.disabled = false; btn.textContent = lbl; }
}

/* ---------- Duplicate dashboard (from the list view) ----------
   Deep-copies a dashboard's widgets into a brand-new one owned by the current
   user. Optionally re-points every widget at a chosen office (replacing each
   widget's existing office filter), so a board built for one office can be
   cloned for another in a single step. */
function openDuplicateModal(guid, title) {
  dupSourceGuid = guid;
  dupOffices = [];
  $("dup_name").value = title ? `Copy of ${title}` : "";
  $("dup_nameErr").textContent = "";
  $("dup_officeErr").textContent = "";
  $("dup_applyOffice").checked = false;
  $("dup_officeBox").hidden = true;
  $("dup_officeSearch").value = "";
  renderDupOfficeChips();
  $("dupModal").classList.add("open"); $("dupScrim").classList.add("open");
  setTimeout(() => $("dup_name").focus(), 30);
}
function closeDuplicateModal() {
  $("dupModal").classList.remove("open"); $("dupScrim").classList.remove("open");
}

// -- the modal's own office SAYT (mirrors the widget editor's, separate state) --
function renderDupOfficeChips() {
  $("dup_officeChips").innerHTML = dupOffices
    .map((o) => `<span class="chip">${escapeHtml(o)}<b data-rm="${escapeHtml(o)}" title="Remove">×</b></span>`)
    .join("");
}
async function dupOfficeSearch() {
  const menu = $("dup_officeMenu");
  if (!OFFICES) {
    menu.innerHTML = `<div class="office-loading">Loading offices…</div>`;
    menu.classList.add("open");
    await loadOffices();                                   // wait once — no recursion
    if (!$("dupModal").classList.contains("open")) return; // modal closed meanwhile
  }
  const q = $("dup_officeSearch").value.trim().toLowerCase();
  const list = OFFICES || [];
  const matches = (q ? list.filter((o) => o.toLowerCase().includes(q)) : list)
    .filter((o) => !dupOffices.includes(o))
    .slice(0, 50);
  menu.innerHTML = matches.length
    ? matches.map((o) => `<div class="office-opt" data-office="${escapeHtml(o)}">${escapeHtml(o)}</div>`).join("")
    : `<div class="office-loading">${list.length ? "No matches" : "No offices available"}</div>`;
  menu.classList.add("open");
}
function initDupOfficePicker() {
  if (!$("dup_officeSearch") || !$("dup_officeMenu") || !$("dup_officeChips")) return; // stale cached HTML
  $("dup_applyOffice").addEventListener("change", (e) => {
    $("dup_officeBox").hidden = !e.target.checked;
    $("dup_officeErr").textContent = "";
    if (e.target.checked) { loadOffices(); setTimeout(() => $("dup_officeSearch").focus(), 30); }
  });
  $("dup_officeSearch").addEventListener("input", dupOfficeSearch);
  $("dup_officeSearch").addEventListener("focus", dupOfficeSearch);
  $("dup_officeSearch").addEventListener("blur", () => setTimeout(() => $("dup_officeMenu").classList.remove("open"), 150));
  $("dup_officeMenu").addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".office-opt");
    if (!opt) return;
    e.preventDefault();
    const o = opt.getAttribute("data-office");
    if (o && !dupOffices.includes(o)) dupOffices.push(o);
    $("dup_officeSearch").value = "";
    renderDupOfficeChips();
    dupOfficeSearch();
  });
  $("dup_officeChips").addEventListener("click", (e) => {
    const rm = e.target.getAttribute("data-rm");
    if (rm) { dupOffices = dupOffices.filter((x) => x !== rm); renderDupOfficeChips(); }
  });
}

async function submitDuplicate() {
  const title = $("dup_name").value.trim();
  if (!title) { $("dup_nameErr").textContent = "Give the new dashboard a name."; return; }
  const applyOffice = $("dup_applyOffice").checked;
  if (applyOffice && dupOffices.length === 0) {
    $("dup_officeErr").textContent = "Choose at least one office, or untick the option.";
    return;
  }
  const btn = $("dup_create");
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Duplicating…";
  try {
    // 1. pull the source dashboard's full widget definitions
    const src = await api("/api/dashboard/" + encodeURIComponent(dupSourceGuid));
    if (!src || !src.guid) { $("dup_nameErr").textContent = "Could not read the source dashboard."; return; }
    // 2. deep-clone the widgets; optionally replace every office filter
    const widgets = JSON.parse(JSON.stringify(src.widgets || []));
    if (applyOffice) {
      widgets.forEach((w) => { w.spec = w.spec || {}; w.spec.officeFilters = [...dupOffices]; });
    }
    // 3. create the new dashboard, then save the cloned widgets into it
    const created = await api("/api/dashboards", { method: "POST", body: JSON.stringify({ title }) });
    if (!created || !created.guid) { $("dup_nameErr").textContent = (created && created.error) || "Could not create the copy."; return; }
    const saved = await api("/api/dashboard/" + created.guid, {
      method: "PUT",
      body: JSON.stringify({ title, widgets, refreshInterval: src.refreshInterval || "0" }),
    });
    if (!saved || !saved.ok) { $("dup_nameErr").textContent = (saved && saved.error) || "Copied, but saving the widgets failed."; return; }
    location.href = "/?d=" + created.guid;   // open the new dashboard
  } catch (e) {
    $("dup_nameErr").textContent = String(e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* /dashboards route: table of the signed-in user's dashboards. */
const IS_LIST_VIEW = location.pathname.replace(/\/+$/, "") === "/dashboards";

async function renderListView() {
  // Keep the white utility bar as its own strip above the table well —
  // board-only actions hidden, the tab marked active.
  ["shareBtn", "addBtn", "saveBtn"].forEach((id) => { const el = $(id); if (el) el.style.display = "none"; });
  $("listNewBtn").hidden = false;              // "+ New dashboard" lives in the strip here
  $("dashListBtn").classList.add("is-active");
  document.querySelector(".grid-stack").style.display = "none";
  $("emptyState").style.display = "none";
  $("listView").hidden = false;
  setCrumb("All dashboards");

  const tbody = $("dashRows");
  tbody.innerHTML = `<tr><td colspan="5" class="pp-cell-muted">Loading…</td></tr>`;
  const r = await api("/api/dashboards");
  const rows = (r && r.dashboards) || [];
  $("dashEmpty").hidden = rows.length > 0;
  tbody.innerHTML = rows.map((d) => {
    const author = d.createdBy && (d.createdBy.name || d.createdBy.email || ("user " + d.createdBy.id)) || "—";
    return `<tr data-guid="${escapeHtml(d.guid)}" data-title="${escapeHtml(d.title)}">
      <td class="pp-cell-strong"><span class="dash-name" data-open="1">${escapeHtml(d.title)}</span></td>
      <td>${d.widgetCount || 0}</td>
      <td>${escapeHtml(author)}</td>
      <td class="pp-cell-muted">${escapeHtml(fmtWhen(d.updatedAt))}</td>
      <td style="text-align:right">
        <button class="btn primary" data-open="1">View Dashboard</button>
        <button class="btn" data-ren="1" title="Rename dashboard">Rename</button>
        <button class="btn" data-dup="1" title="Duplicate dashboard">Duplicate</button>
        <button class="btn" data-del="1" title="Delete dashboard">Delete</button>
      </td>
    </tr>`;
  }).join("");
  tbody.onclick = async (e) => {
    const row = e.target.closest("tr[data-guid]"); if (!row) return;
    const guid = row.getAttribute("data-guid");
    if (e.target.closest("[data-open]")) { location.href = "/?d=" + guid; return; }
    if (e.target.closest("[data-ren]")) { openRenameModal(guid, row.getAttribute("data-title") || ""); return; }
    if (e.target.closest("[data-dup]")) { openDuplicateModal(guid, row.getAttribute("data-title") || ""); return; }
    if (e.target.closest("[data-del]")) {
      if (!confirm("Delete this dashboard? This cannot be undone.")) return;
      const dr = await api("/api/dashboard/" + guid, { method: "DELETE" });
      if (dr && dr.ok) { row.remove(); $("dashEmpty").hidden = !!$("dashRows").children.length; }
      else alert((dr && dr.error) || "Delete failed");
    }
  };
}

function copyShareLink(guid) {
  const url = `${location.origin}/?d=${guid || CURRENT_DASH.guid}`;
  navigator.clipboard?.writeText(url).then(
    () => { $("status").textContent = "link copied ✓"; setTimeout(() => ($("status").textContent = ""), 2000); },
    () => prompt("Copy this link:", url),
  );
}

async function loadDashboard() {
  const urlGuid = new URLSearchParams(location.search).get("d");
  let d = null;
  if (urlGuid) {
    d = await api("/api/dashboard/" + encodeURIComponent(urlGuid));
    if (!d || d.notFound || !d.guid) d = null;
  }
  if (!d) {
    // No (valid) dashboard in the URL — the dashboards table is the landing page.
    location.replace("/dashboards");
    return;
  }
  CURRENT_DASH = { guid: d.guid, canEdit: d.canEdit !== false, createdBy: d.createdBy || null };
  applyEditMode();
  dashboardMeta = {
    title: d.title || "My Dashboard",
    refreshInterval: d.refreshInterval || "0",
    lastRefreshedAt: d.lastRefreshedAt || null,
  };
  setCrumb(dashboardMeta.title);

  (d.widgets || []).forEach((w) => {
    w.spec = normalizeSpec(w.spec);
    // Re-resolve date presets so saved widgets stay rolling (e.g. "Last 2 Months").
    const pr = w.spec && resolvePreset(w.spec.datePreset);
    if (pr) { w.spec.dateFrom = pr.from; w.spec.dateTo = pr.to; }
    addWidgetToGrid(w);
  });

  // Scheduled refresh: if the data is older than the dashboard's interval, refetch
  // everything (bypassing cache) rather than serving stale numbers. Never in the
  // public share view — anonymous visitors have no credentials to fetch with.
  const stale = !PUBLIC_VIEW && isStale(dashboardMeta);
  if (stale) $("status").textContent = "refreshing data…";
  widgets.forEach((w) => renderWidget(w, { nocache: stale }));
  if (stale) {
    try {
      await api(`/api/dashboard/${CURRENT_DASH.guid}/refreshed`, { method: "POST" });
      dashboardMeta.lastRefreshedAt = new Date().toISOString();
    } catch {}
    $("status").textContent = "";
  }
  updateEmptyState();
}

// ---------- init ----------
async function main() {
  try {
    const who = await api("/api/auth/status");
    AUTH_INFO = who;
    CURRENT_USER = who.identity || null;
    // Feed the shared pronto-base nav (avatar initials + tooltip).
    window.ProntoPage = window.ProntoPage || {};
    window.ProntoPage.user = who.identity
      ? { name: userLabel(CURRENT_USER), href: "#" }
      : {};                                            // signed out: empty avatar
    if (who.authRequired) {
      // Shared link (?d=<guid>) opened without a session: render the PUBLIC
      // view-only snapshot (cached data, no refresh) instead of forcing login.
      const guid = new URLSearchParams(location.search).get("d");
      if (!IS_LIST_VIEW && guid) {
        PUBLIC_VIEW = true;
        // The empty avatar offers a "Log in" entry for viewers who want more.
        window.ProntoPage.userMenu = { sections: [{ items: [
          { id: "login", label: "Log in", icon: "user", onClick: () => showLogin(AUTH_INFO) },
        ] }] };
      } else { showLogin(who); return; }               // halt until the user signs in
    }
    document.querySelector("pronto-nav")?.refresh();
    // The status call itself carries authRequired, which makes api() pop the
    // login screen before PUBLIC_VIEW is known — always dismiss it here.
    hideLogin();
  } catch {}

  // /dashboards route: just the table — none of the widget machinery.
  if (IS_LIST_VIEW) {
    $("listNewBtn").onclick = openCreateDash;
    $("c_create").onclick = createDashboard;
    $("c_cancel").onclick = closeCreateDash;
    $("createClose").onclick = closeCreateDash;
    $("createScrim").onclick = closeCreateDash;
    $("c_name").addEventListener("keydown", (e) => { if (e.key === "Enter") createDashboard(); });
    // Duplicate-dashboard modal (name + optional office re-filter)
    $("dup_create").onclick = submitDuplicate;
    $("dup_cancel").onclick = closeDuplicateModal;
    $("dupClose").onclick = closeDuplicateModal;
    $("dupScrim").onclick = closeDuplicateModal;
    $("dup_name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitDuplicate(); });
    initDupOfficePicker();
    // Rename-dashboard modal
    $("ren_save").onclick = submitRename;
    $("ren_cancel").onclick = closeRenameModal;
    $("renClose").onclick = closeRenameModal;
    $("renScrim").onclick = closeRenameModal;
    $("ren_name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitRename(); });
    await renderListView();
    return;
  }

  OPTIONS = await api("/api/report/options");
  buildLabelMaps();
  initEditorOptions();
  // Office list needs a session; the public share view never opens the editor.
  if (!PUBLIC_VIEW) { try { initOfficePicker(); loadOffices(); } catch (e) { console.warn("office picker init skipped:", e); } }

  grid = GridStack.init({ cellHeight: 90, margin: 8, float: true, handle: ".w-head", resizable: { handles: "e, se, s, sw, w" } });

  const resizeChart = (el) => { const id = el.getAttribute("gs-id"); const w = widgets.get(id); if (w && w.chart) w.chart.resize(); };
  grid.on("resize", (e, el) => resizeChart(el));
  grid.on("resizestop", (e, el) => resizeChart(el));
  window.addEventListener("resize", () => widgets.forEach((w) => w.chart && w.chart.resize()));

  $("addBtn").onclick = () => openEditor(null);
  $("saveBtn").onclick = openDashSettings;          // saving now goes via the settings modal
  $("listNewBtn").onclick = openCreateDash;
  $("dashListBtn").onclick = () => { location.href = "/dashboards"; };
  $("shareBtn").onclick = () => copyShareLink();
  $("c_create").onclick = createDashboard;
  $("c_cancel").onclick = closeCreateDash;
  $("createClose").onclick = closeCreateDash;
  $("createScrim").onclick = closeCreateDash;
  $("c_name").addEventListener("keydown", (e) => { if (e.key === "Enter") createDashboard(); });
  $("dashSaveBtn").onclick = saveDashboard;
  $("dashCancelBtn").onclick = closeDashSettings;
  $("dashModalClose").onclick = closeDashSettings;
  $("dashModalScrim").onclick = closeDashSettings;
  $("d_name").addEventListener("keydown", (e) => { if (e.key === "Enter") saveDashboard(); });
  $("applyBtn").onclick = applyEditor;
  $("cancelBtn").onclick = closeEditor;
  $("drawerClose").onclick = closeEditor;
  $("scrim").onclick = closeEditor;

  await loadDashboard();
}

/* ---- login / logout (per-user sessions) ------------------------------------ */
let AUTH_INFO = null;

function showLogin(info) {
  if (info) AUTH_INFO = info;
  const el = $("loginScreen");
  if (!el) return;
  const link = $("tokenGenLink");
  const url = AUTH_INFO && AUTH_INFO.tokenGeneratorUrl;
  if (link) { if (url) { link.href = url; link.hidden = false; } else { link.hidden = true; } }
  // Public share view: the login screen is optional — offer a way back.
  const bw = $("loginBackWrap");
  if (bw) bw.hidden = !PUBLIC_VIEW;
  // Broker button only when the server says the flow is available.
  const brokerOff = AUTH_INFO && AUTH_INFO.broker === false;
  const bb = $("brokerBtn"), bd = $("brokerDivider");
  if (bb) bb.hidden = brokerOff;
  if (bd) bd.hidden = brokerOff;
  el.hidden = false;
}
function hideLogin() { const el = $("loginScreen"); if (el) el.hidden = true; }

window.prontoLogout = async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
  location.reload();
};

function wireLogin() {
  const err = (m) => { const e = $("loginErr"); if (e) { e.textContent = m || ""; e.hidden = !m; } };
  // raw fetch (not api()) so a failed login can't re-trigger showLogin loops
  const submit = async (body, btn) => {
    err(""); const prev = btn.textContent; btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) { location.reload(); return; }
      err((j && j.error) || `Login failed (HTTP ${r.status})`);
    } catch (e) { err(String(e)); }
    btn.disabled = false; btn.textContent = prev;
  };
  $("loginForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("l_email").value.trim(), password = $("l_password").value;
    if (!email || !password) return err("Enter your email and password.");
    submit({ email, password }, e.submitter || e.target.querySelector("button"));
  });
  $("tokenForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = $("l_token").value.trim();
    if (!token) return err("Paste a token first.");
    submit({ token }, e.submitter || e.target.querySelector("button"));
  });
  $("loginBack")?.addEventListener("click", (e) => { e.preventDefault(); hideLogin(); });

  // ---- "Sign in with HavasPronto" (PKCE broker): open the Pronto site,
  // then poll until the login completes there. ----
  const brokerBtn = $("brokerBtn");
  brokerBtn?.addEventListener("click", async () => {
    err("");
    const st = $("brokerStatus");
    const prev = brokerBtn.textContent;
    const reset = () => { brokerBtn.disabled = false; brokerBtn.textContent = prev; if (st) st.hidden = true; };
    brokerBtn.disabled = true; brokerBtn.textContent = "Opening Pronto sign-in…";
    let start;
    try {
      const r = await fetch("/api/auth/broker/start", { method: "POST" });
      start = await r.json().catch(() => null);
      if (!start || !start.ok) { err((start && start.error) || `Could not start sign-in (HTTP ${r.status})`); return reset(); }
    } catch (e) { err(String(e)); return reset(); }

    // Keep a handle so we can CLOSE the Pronto tab the moment sign-in completes —
    // the broker always returns to its own pages (timer prompt / homepage), which
    // we can't change from this side. Sever window.opener for safety.
    const popup = window.open(start.loginUrl, "_blank");
    if (popup) { try { popup.opener = null; } catch {} }
    if (st) {
      st.hidden = false;
      st.textContent = popup
        ? "Complete the sign-in in the Pronto tab — it closes by itself and this page finishes automatically. (Anything Pronto shows over there can be ignored.)"
        : "Popup blocked — allow popups for this site, or complete the sign-in in another tab; this page finishes automatically.";
    }
    brokerBtn.textContent = "Waiting for Pronto sign-in…";

    const startedAt = Date.now();
    const poll = async () => {
      if (Date.now() - startedAt > 5 * 60 * 1000) { err("Timed out waiting for the Pronto sign-in. Try again."); return reset(); }
      try {
        const pr = await fetch("/api/auth/broker/poll", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: start.pid }),
        });
        const pj = await pr.json().catch(() => null);
        if (pj && pj.ok && !pj.pending) {
          try { if (popup && !popup.closed) popup.close(); } catch {}
          try { window.focus(); } catch {}
          location.reload(); return;
        }
        if (pj && pj.ok && pj.pending) { setTimeout(poll, pj.retryAfter ? pj.retryAfter * 1000 : (start.pollMs || 3000)); return; }
        err((pj && pj.error) || "Pronto sign-in failed. Try again.");
        reset();
      } catch { setTimeout(poll, 5000); }   // transient network blip — keep waiting
    };
    setTimeout(poll, start.pollMs || 3000);
  });
}

wireLogin();
main();
