/**
 * What a stacked column says when you hover it.
 *
 * A twenty-brand stack listed every series in the tooltip, most of them zero, which
 * buried the one the cursor was actually on. It should name that one — the way the pie
 * does — and still show the overlay line's own figure underneath, since a column is
 * being read at a single moment in time.
 *
 *   node test/test-tooltip-ui.mjs
 *
 * Needs gridstack + echarts on disk (CHART_LIBS, default /tmp/pd/node_modules) and a
 * playwright install (PLAYWRIGHT_PKG). Both are served to the page locally because the
 * sandbox has no route to the CDN.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.TEST_WORK_DIR || path.join(HERE, ".work");
const CHART_LIBS = process.env.CHART_LIBS || "/tmp/pd/node_modules";
const PLAYWRIGHT_PKG = process.env.PLAYWRIGHT_PKG || "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = (await import(PLAYWRIGHT_PKG)).default;

const OWNER = "http://localhost:8911";
const kids = [];
const boot = (f, a = []) => { const p = spawn("node", [f, ...a], { stdio: ["ignore", "ignore", "inherit"] }); kids.push(p); return p; };
let failures = 0;
const ok = (c, m) => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${m}`); if (!c) failures++; };
const step = (m) => console.log("\n• " + m);
const j = async (u, o) => (await fetch(u, { headers: { "Content-Type": "application/json" }, ...o })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPEC = {
  dataSource: "job", groupBy: "client_office_name", interval: "1MONTH", displayAs: "count",
  datePreset: "Custom Dates", dateFrom: "2026-01-01", dateTo: "2026-06-30", limit: 10,
  filters: [], officeFilters: [],
  overlay: { enabled: true, dataSource: "timesheet_user_data", displayAs: "sum", statsField: "hours" },
};

let browser;
try {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  process.env.TEST_WORK_DIR = WORK;
  boot(path.join(HERE, "fake-upstream-monthly.mjs"));
  boot(path.join(HERE, "serve-monthly.mjs"), ["8911", "all"]);
  await sleep(1800);

  const dash = await j(`${OWNER}/api/dashboards`, { method: "POST", body: JSON.stringify({ title: "Tooltips" }) });
  await j(`${OWNER}/api/dashboard/${dash.guid}`, { method: "PUT", body: JSON.stringify({
    title: "Tooltips", refreshInterval: "0", widgets: [
      { id: "w1", title: "Stacked", chartType: "stacked", theme: "board", spec: SPEC, x: 0, y: 0, w: 12, h: 5 },
      { id: "w2", title: "Grouped", chartType: "bar", theme: "board", spec: SPEC, x: 0, y: 5, w: 12, h: 5 },
    ] }) });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const CDN = {
    "gridstack-all.js": path.join(CHART_LIBS, "gridstack/dist/gridstack-all.js"),
    "gridstack.min.css": path.join(CHART_LIBS, "gridstack/dist/gridstack.min.css"),
    "echarts.min.js": path.join(CHART_LIBS, "echarts/dist/echarts.min.js"),
  };
  await page.route("**/cdn.jsdelivr.net/**", (route) => {
    const hit = Object.entries(CDN).find(([n]) => route.request().url().endsWith(n));
    if (!hit) return route.abort();
    route.fulfill({ status: 200, contentType: hit[0].endsWith(".css") ? "text/css" : "application/javascript", body: fs.readFileSync(hit[1], "utf8") });
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

  await page.goto(`${OWNER}/?d=${dash.guid}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: ":root{--pp-nav-h:0px}" });
  await page.waitForTimeout(3000);

  // Where a stacked segment actually sits, in page coordinates: ask ECharts to convert
  // a (category, value) pair back to pixels, so each hover lands inside a known band.
  const pointFor = (dataIndex, value, chartIdx = 0) => page.evaluate(([i, v, k]) => {
    const el = document.querySelectorAll(".grid-stack-item .w-chart")[k];
    const c = window.echarts.getInstanceByDom(el);
    const p = c.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [i, v]);
    const box = el.getBoundingClientRect();
    return { x: box.left + p[0], y: box.top + p[1] };
  }, [dataIndex, value, chartIdx]);

  const tip = () => page.evaluate(() => {
    const all = [...document.querySelectorAll("div")].filter((d) =>
      /Havas London|Havas Life|Timesheet Data|across/.test(d.textContent || "")
      && /position: absolute/.test(d.getAttribute("style") || ""));
    const el = all[all.length - 1];
    return el ? el.innerText.replace(/\s+\n/g, "\n").trim() : "";
  });

  // A single jump doesn't always register as a hover — move in, then across.
  const hover = async (pt) => {
    await page.mouse.move(pt.x - 30, pt.y - 30);
    await page.mouse.move(pt.x, pt.y, { steps: 8 });
    await page.waitForTimeout(450);
  };

  step("Hovering one band names that band, not the whole column");
  // Month 3 (index 2): Havas London 8, Havas Life Chelsea 4 → London occupies 0–8.
  await hover(await pointFor(2, 2));
  let t = await tip();
  ok(/Havas London/.test(t), `the hovered series is named (${JSON.stringify(t.split("\n").slice(0, 3))})`);
  ok(!/Havas Life Chelsea/.test(t), "and the one it isn't on is not listed");
  ok(/% of/.test(t), "with its share of the column for context");
  ok(/Timesheet Data/.test(t), "the overlay line still reports alongside it");

  step("Moving up the same column names the band above");
  await hover(await pointFor(2, 10));        // 8–12 belongs to the second series
  t = await tip();
  ok(/Havas Life Chelsea/.test(t), `the other band is named (${JSON.stringify(t.split("\n").slice(0, 3))})`);
  ok(!/Havas London:/.test(t), "and the first one has dropped out");

  step("Above the top of the column there is no band to name");
  // Just above this column's total (12) but still inside the plot — outside it there is
  // no tooltip at all, which would prove nothing.
  await hover(await pointFor(2, 13));
  t = await tip();
  ok(/across 2 series/.test(t), `so it gives the column's total instead (${JSON.stringify(t.split("\n")[1] || "")})`);
  ok(!/Havas London:/.test(t), "…rather than falling back to the full list");

  step("The line rollover still wins where the line is");
  const lineAt = await page.evaluate(() => {
    const el = document.querySelector(".grid-stack-item .w-chart");
    const c = window.echarts.getInstanceByDom(el);
    const line = c.getOption().series.find((s) => s.type === "line");
    const p = c.convertToPixel({ xAxisIndex: 0, yAxisIndex: 1 }, [2, line.data[2]]);
    const box = el.getBoundingClientRect();
    return { x: box.left + p[0], y: box.top + p[1] };
  });
  await hover(lineAt);
  t = await tip();
  ok(/Timesheet Data/.test(t), "the line is reported");
  ok(!/Havas London/.test(t) && !/across 2 series/.test(t), `and nothing else (${JSON.stringify(t.split("\n"))})`);

  step("Grouped bars name the one under the cursor too");
  // Side-by-side bars can't be told apart by height, so this path leans on ECharts' own
  // hit test rather than on the pointer's value — worth its own check.
  await page.evaluate(() => document.querySelectorAll(".grid-stack-item")[1].scrollIntoView({ block: "center" }));
  await page.waitForTimeout(600);
  const grouped = await page.evaluate(() => {
    const el = document.querySelectorAll(".grid-stack-item .w-chart")[1];
    const c = window.echarts.getInstanceByDom(el);
    const p = c.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [2, 2]);
    const box = el.getBoundingClientRect();
    const band = c.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [3, 2])[0] - p[0];
    return { x: box.left + p[0] + band * 0.22, y: box.top + p[1] };   // right of centre: second series
  });
  await hover(grouped);
  t = await tip();
  ok(/Havas Life Chelsea/.test(t) && !/Havas London:/.test(t),
    `only the bar under the cursor (${JSON.stringify(t.split("\n").slice(0, 3))})`);

  ok(errs.length === 0, `no JS errors${errs.length ? ": " + errs.join(" | ") : ""}`);
  await page.screenshot({ path: path.join(WORK, "shot-tooltip.png") });
} catch (e) {
  console.error("\nTEST ERROR:", e);
  failures++;
} finally {
  try { await browser?.close(); } catch {}
  kids.forEach((p) => { try { p.kill("SIGKILL"); } catch {} });
  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed ✓\n");
  process.exit(failures ? 1 : 0);
}
