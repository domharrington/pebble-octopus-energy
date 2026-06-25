/*
 * Octopus Energy — watch-side (embeddedjs, Pebble Time 2).
 *
 * Views (UP/DOWN cycle): Live · Day · Week · Month · Year.
 * The phone sends two series per view: track A (Live=W, others=kWh) and,
 * for energy views, track B (£). SELECT toggles A/B (kWh <-> £) instantly.
 * Live polls every ~30s only while it's the active view.
 */
import Poco from "commodetto/Poco";
import Message from "pebble/message";
import Button from "pebble/button";

const render = new Poco(screen);

const C_BG    = render.makeColor(20, 8, 44);
const C_BAR   = render.makeColor(232, 80, 208);
const C_TEXT  = render.makeColor(255, 255, 255);
const C_MUTED = render.makeColor(150, 130, 180);
const C_GRID  = render.makeColor(64, 44, 96);

const fTotal = new render.Font("Bitham-Black", 30);
const fUnit  = new render.Font("Gothic-Bold", 18);
const fSmall = new render.Font("Gothic-Regular", 14);

let state = {
  status: "loading",
  label: "",
  axis: [],                       // axis label strings
  a: { bars: [], total: "", unit: "" },
  b: null                         // { bars, total, unit } or null
};
let track = "a";                  // active display track (persists across views)

const VIEWS = ["live", "day", "week", "month", "year"];
let view = "live";
let canSend = false;
let requested = false;            // have we made the initial request this session?
let started = false;
let liveTimer = null;
let retryTimer = null;
let retries = 0;
const LIVE_INTERVAL_MS = 30000;

function csv(s) {
  if (!s) return [];
  const out = s.split(",");
  for (let i = 0; i < out.length; i++) out[i] = Number(out[i]) || 0;
  return out;
}
function activeTrack() { return (track === "b" && state.b) ? state.b : state.a; }
function centerText(text, font, color, y) {
  render.drawText(text, font, color, (render.width - render.getTextWidth(text, font)) / 2, y);
}

function draw() {
  const W = render.width, H = render.height;
  render.begin();
  render.fillRectangle(C_BG, 0, 0, W, H);

  if (state.status === "loading") { centerText("Loading…", fUnit, C_MUTED, (H - fUnit.height) / 2); render.end(); return; }
  if (state.status === "error")   { centerText("Error", fUnit, C_BAR, H / 2 - 20); centerText(state.label || "check phone", fSmall, C_MUTED, H / 2 + 4); render.end(); return; }
  if (state.status === "nodata")  { centerText(state.label || "—", fUnit, C_MUTED, H / 2 - 20); centerText("No data", fSmall, C_MUTED, H / 2 + 4); render.end(); return; }

  const t = activeTrack();
  const isMoney = t.unit === "GBP";

  /* Header: big total (+ unit) and the label */
  const big = isMoney ? "£" + t.total : t.total;
  const totalW = render.getTextWidth(big, fTotal);
  const suffix = isMoney ? "" : " " + t.unit;
  const sufW = suffix ? render.getTextWidth(suffix, fUnit) : 0;
  const x0 = (W - (totalW + sufW)) / 2;
  render.drawText(big, fTotal, C_TEXT, x0, 6);
  if (suffix) render.drawText(suffix, fUnit, C_MUTED, x0 + totalW, 6 + (fTotal.height - fUnit.height));
  centerText(state.label, fSmall, C_MUTED, 6 + fTotal.height);

  /* Chart */
  const bars = t.bars;
  const chartTop = 6 + fTotal.height + fSmall.height + 6;
  const axisH = fSmall.height + 2;
  const chartBottom = H - axisH;
  const chartH = chartBottom - chartTop;
  const padX = 6;
  const chartW = W - padX * 2;

  let max = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i] > max) max = bars[i];
  if (max <= 0) max = 1;

  render.fillRectangle(C_GRID, padX, chartBottom, chartW, 1);

  // Fixed-period views are padded to full slots by the phone, so fill the width
  // left-aligned (e.g. Week = Mon..Sun, each bar in its day slot like the app).
  const n = bars.length || 1;
  const slot = chartW / n;
  const chartX = padX;
  const barW = Math.max(1, Math.floor(slot) - 1);
  for (let i = 0; i < bars.length; i++) {
    const h = Math.round((bars[i] / max) * chartH);
    if (h <= 0) continue;
    render.fillRectangle(C_BAR, Math.round(chartX + i * slot), chartBottom - h, barW, h);
  }

  /* Axis labels (from the phone). One label per bar -> centre under each bar;
     otherwise spread across. Thin to at most ~7. */
  const labels = state.axis;
  if (labels && labels.length) {
    const aligned = labels.length === bars.length;
    const step = Math.max(1, Math.ceil(labels.length / 7));
    for (let k = 0; k < labels.length; k += step) {
      const lw = render.getTextWidth(labels[k], fSmall);
      const x = aligned ? chartX + (k + 0.5) * slot - lw / 2 : chartX + (k / labels.length) * chartW;
      render.drawText(labels[k], fSmall, C_MUTED, Math.round(x), chartBottom + 1);
    }
  }
  render.end();
}

/* ── Phone link ───────────────────────────────────────────────────────────── */
function sendReq(v) {
  if (!canSend) return;
  const m = new Map();
  m.set("REQUEST", v);
  message.write(m);
}
// Request a view and watch for a reply; re-ask if nothing arrives. This is what
// recovers a fresh app launch / re-entry, where the phone may not push on its own.
function requestView(v) {
  retries = 0;
  sendReq(v);
  armRetry();
}
function armRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(function () {
    retryTimer = null;
    if (state.status !== "loading") return;   // a reply landed
    if (retries++ >= 4) return;                // give up after ~20s
    sendReq(view);
    armRetry();
  }, 4000);
}
function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }
function clearLiveTimer() { if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } }
function scheduleLivePoll() {
  clearLiveTimer();
  liveTimer = setTimeout(function () {
    liveTimer = null;
    if (view !== "live") return;
    requestView("live");
    scheduleLivePoll();
  }, LIVE_INTERVAL_MS);
}
function setView(v) {
  view = v;
  state.status = "loading";
  state.a = { bars: [], total: "", unit: "" };
  state.b = null;
  draw();
  requestView(v);
  if (v === "live") scheduleLivePoll(); else clearLiveTimer();
}

const message = new Message({
  keys: ["REQUEST", "STATUS", "LABEL", "AXIS", "ERROR", "A_BARS", "A_TOTAL", "A_UNIT", "B_BARS", "B_TOTAL", "B_UNIT"],
  onReadable() {
    canSend = true;
    const m = this.read();
    const status = m.get("STATUS");
    if (status) state.status = status;
    if (m.has("LABEL")) state.label = m.get("LABEL");
    if (status === "error") state.label = m.get("ERROR") || "error";
    if (status === "ok") {
      state.axis = (m.get("AXIS") || "").split(",").filter(function (s) { return s.length; });
      state.a = { bars: csv(m.get("A_BARS")), total: m.get("A_TOTAL") || "", unit: m.get("A_UNIT") || "" };
      state.b = m.has("B_BARS") ? { bars: csv(m.get("B_BARS")), total: m.get("B_TOTAL") || "", unit: m.get("B_UNIT") || "" } : null;
    }
    if (status === "ok" || status === "nodata" || status === "error") clearRetry();
    draw();
    if (!started) { started = true; if (view === "live") scheduleLivePoll(); }
  },
  onWritable() {
    canSend = true;
    // Channel is open: make the initial request once (covers app launch/re-entry,
    // where the phone may already be running and won't push on its own).
    if (!requested) { requested = true; requestView(view); }
  }
});

new Button({
  types: ["up", "down", "select"],
  onPush(down, type) {
    if (!down) return;
    if (type === "select") {
      // toggle £/kWh on views that have a cost track
      if (state.b) { track = (track === "a") ? "b" : "a"; draw(); }
    } else {
      let i = VIEWS.indexOf(view);
      i = (i + (type === "up" ? -1 : 1) + VIEWS.length) % VIEWS.length;
      setView(VIEWS[i]);
    }
  }
});

draw();
