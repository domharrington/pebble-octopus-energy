/*
 * Octopus Energy — watch-side (embeddedjs, runs on the Pebble Time 2).
 *
 * Receives a normalised payload from the phone (pkjs) and draws a kWh bar
 * chart for the day. Press SELECT to refresh.
 */
import Poco from "commodetto/Poco";
import Message from "pebble/message";
import Button from "pebble/button";

const render = new Poco(screen);

/* Octopus theme */
const C_BG    = render.makeColor(20, 8, 44);     // deep indigo
const C_BAR   = render.makeColor(232, 80, 208);  // magenta/pink
const C_TEXT  = render.makeColor(255, 255, 255);
const C_MUTED = render.makeColor(150, 130, 180);
const C_GRID  = render.makeColor(64, 44, 96);

const fTotal = new render.Font("Bitham-Black", 30);   // big number
const fUnit  = new render.Font("Gothic-Bold", 18);    // unit + header
const fSmall = new render.Font("Gothic-Regular", 14); // axis + messages

let state = { status: "loading", label: "", total: "", unit: "", bars: [] };

function parseBars(csv) {
  if (!csv) return [];
  const out = csv.split(",");
  for (let i = 0; i < out.length; i++) out[i] = Number(out[i]) || 0;
  return out;
}

function centerText(text, font, color, y) {
  const w = render.getTextWidth(text, font);
  render.drawText(text, font, color, (render.width - w) / 2, y);
}

function draw() {
  const W = render.width, H = render.height;
  render.begin();
  render.fillRectangle(C_BG, 0, 0, W, H);

  if (state.status === "loading") {
    centerText("Loading…", fUnit, C_MUTED, (H - fUnit.height) / 2);
    render.end();
    return;
  }
  if (state.status === "error") {
    centerText("Error", fUnit, C_BAR, H / 2 - 20);
    centerText(state.label || "check phone", fSmall, C_MUTED, H / 2 + 4);
    render.end();
    return;
  }
  if (state.status === "nodata") {
    centerText(state.label || "TODAY", fUnit, C_MUTED, H / 2 - 20);
    centerText("No data yet", fSmall, C_MUTED, H / 2 + 4);
    render.end();
    return;
  }

  /* Header: big total + unit, then the day label */
  const totalW = render.getTextWidth(state.total, fTotal);
  const unitW = render.getTextWidth(" " + state.unit, fUnit);
  const startX = (W - (totalW + unitW)) / 2;
  render.drawText(state.total, fTotal, C_TEXT, startX, 6);
  render.drawText(" " + state.unit, fUnit, C_MUTED, startX + totalW, 6 + (fTotal.height - fUnit.height));
  centerText(state.label, fSmall, C_MUTED, 6 + fTotal.height);

  /* Chart area */
  const bars = state.bars;
  const chartTop = 6 + fTotal.height + fSmall.height + 6;
  const axisH = fSmall.height + 2;
  const chartBottom = H - axisH;
  const chartH = chartBottom - chartTop;
  const padX = 6;
  const chartW = W - padX * 2;

  let max = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i] > max) max = bars[i];
  if (max <= 0) max = 1;

  /* baseline */
  render.fillRectangle(C_GRID, padX, chartBottom, chartW, 1);

  // Cap bar width (so a few bars don't stretch huge) and centre the group.
  const n = bars.length || 1;
  const slot = Math.min(chartW / n, 18);
  const groupW = slot * n;
  const chartX = padX + (chartW - groupW) / 2;
  const barW = Math.max(1, Math.floor(slot) - 1);
  for (let i = 0; i < bars.length; i++) {
    const h = Math.round((bars[i] / max) * chartH);
    if (h <= 0) continue;
    const x = Math.round(chartX + i * slot);
    render.fillRectangle(C_BAR, x, chartBottom - h, barW, h);
  }

  /* hour axis labels every 6 hours for the day view only */
  if (view === "day" && bars.length === 24) {
    const labels = ["00", "06", "12", "18"];
    for (let k = 0; k < labels.length; k++) {
      const hr = k * 6;
      const x = Math.round(chartX + hr * slot);
      render.drawText(labels[k], fSmall, C_MUTED, x, chartBottom + 1);
    }
  }

  render.end();
}

/* ---- Phone communication & views ----
 * Two views: "live" (Home Mini watts, polled while open) and "day" (kWh history).
 * UP/DOWN switch view, SELECT refreshes. Live polling runs ONLY while the live
 * view is open and stops when we switch away or the app closes (its timer dies
 * with the app), so we never hammer the API or the battery in the background.
 */
let canSend = false;
let started = false;
const VIEWS = ["live", "day", "week", "month", "year"];
let view = "live";          // default to the marquee Live view
let liveTimer = null;
const LIVE_INTERVAL_MS = 30000;

const message = new Message({
  keys: ["REQUEST", "STATUS", "LABEL", "TOTAL", "UNIT", "BARS", "ERROR"],
  onReadable() {
    canSend = true;
    const msg = this.read();
    const status = msg.get("STATUS");
    if (status) state.status = status;
    if (msg.has("LABEL")) state.label = msg.get("LABEL");
    if (msg.has("TOTAL")) state.total = msg.get("TOTAL");
    if (msg.has("UNIT")) state.unit = msg.get("UNIT");
    if (msg.has("BARS")) state.bars = parseBars(msg.get("BARS"));
    if (status === "error") state.label = msg.get("ERROR") || "error";
    draw();
    // The phone drives the initial load; once we've received it we can send, so
    // start the live poll loop (the watch owns the timer from here on).
    if (!started) { started = true; if (view === "live") scheduleLivePoll(); }
  },
  onWritable() {
    canSend = true;
  }
});

function requestView(v) {
  if (!canSend) return;
  const m = new Map();
  m.set("REQUEST", v);
  message.write(m);
}

function clearLiveTimer() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
}

function scheduleLivePoll() {
  clearLiveTimer();
  liveTimer = setTimeout(function () {
    liveTimer = null;
    if (view !== "live") return;
    requestView("live");
    scheduleLivePoll(); // fixed cadence; phone ignores overlapping requests
  }, LIVE_INTERVAL_MS);
}

function setView(v) {
  view = v;
  state.status = "loading";
  state.bars = [];
  draw();
  requestView(v);
  if (v === "live") scheduleLivePoll();
  else clearLiveTimer();
}

function cycleView(dir) {
  let i = VIEWS.indexOf(view);
  i = (i + dir + VIEWS.length) % VIEWS.length;
  setView(VIEWS[i]);
}

new Button({
  types: ["up", "down", "select"],
  onPush(down, type) {
    if (!down) return;
    if (type === "select") {
      state.status = "loading";
      draw();
      requestView(view); // manual refresh of the current view
    } else if (type === "up") {
      cycleView(-1);
    } else { // down
      cycleView(1);
    }
  }
});

draw();
