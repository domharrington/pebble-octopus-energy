/*
 * Octopus Energy — phone-side (PebbleKit JS).
 *
 * Sends the watch a two-series payload per view:
 *   track A = primary  (Live: watts · energy views: kWh)
 *   track B = secondary (energy views: £; absent on Live)
 * SELECT on the watch toggles A/B, so £/kWh switches instantly.
 *
 * Data sources (all Kraken GraphQL — what the Octopus app uses):
 *   Live  -> smartMeterTelemetry  ONE_MINUTE, last 30 min
 *   Day   -> smartMeterTelemetry  HALF_HOURLY, today so far (with cost)
 *   Week/Month/Year -> measurements DAY/DAY/MONTH interval (with cost)
 *
 * Per-view caching: a view switch serves the cached payload instantly; we only
 * re-fetch if the cache is older than its TTL (then refresh in the background).
 *
 * Style: the pkjs bundler is ES5-only (no async/await/arrow fns); Promises work,
 * so XHR is wrapped once and logic reads as flat .then() chains.
 */

/* ── Configuration ───────────────────────────────────────────────────────── */
function merge(target, src) {
  if (!src) return target;
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined && src[k] !== "") target[k] = src[k];
  }
  return target;
}
function requireOptional(path) { try { return require(path); } catch (e) { return {}; } }
function loadConfig() {
  var cfg = { apiKey: "", accountNumber: "", useMock: true };
  try { merge(cfg, require("./config")); } catch (e) {}
  merge(cfg, requireOptional("./config.local"));
  try { var s = localStorage.getItem("settings"); if (s) merge(cfg, JSON.parse(s)); } catch (e) {}
  return cfg;
}
var CONFIG = loadConfig();
var GRAPHQL = "https://api.octopus.energy/v1/graphql/";
var krakenToken = null;

/* ── GraphQL over Promise-wrapped XHR ─────────────────────────────────────── */
function graphqlRaw(query, token, variables) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", GRAPHQL, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    if (token) xhr.setRequestHeader("Authorization", token);
    xhr.timeout = 20000;
    xhr.onload = function () { try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error("Bad GraphQL JSON")); } };
    xhr.onerror = function () { reject(new Error("network error")); };
    xhr.ontimeout = function () { reject(new Error("timed out")); };
    xhr.send(JSON.stringify({ query: query, variables: variables || {} }));
  });
}
function getToken() {
  if (krakenToken) return Promise.resolve(krakenToken);
  var q = 'mutation { obtainKrakenToken(input: {APIKey: "' + CONFIG.apiKey + '"}) { token } }';
  return graphqlRaw(q, null).then(function (res) {
    if (res.errors) throw new Error("Auth: " + res.errors[0].message);
    krakenToken = res.data.obtainKrakenToken.token;
    return krakenToken;
  });
}
function graphqlQuery(query, variables) {
  return getToken().then(function (token) {
    return graphqlRaw(query, token, variables).then(function (res) {
      if (res.errors) {
        var msg = res.errors[0].message || "GraphQL error";
        if (/token|auth|signature|expire|jwt|permission/i.test(msg)) {
          krakenToken = null;
          return getToken().then(function (t2) { return graphqlRaw(query, t2, variables); }).then(function (r2) {
            if (r2.errors) throw new Error(r2.errors[0].message);
            return r2.data;
          });
        }
        throw new Error(msg);
      }
      return res.data;
    });
  });
}
function getDevice() {
  var cached = localStorage.getItem("device_v1");
  if (cached) return Promise.resolve(cached);
  var q = 'query { account(accountNumber: "' + CONFIG.accountNumber + '") ' +
          '{ electricityAgreements(active: true) { meterPoint { meters(includeInactive: false) { smartDevices { deviceId } } } } } }';
  return graphqlQuery(q).then(function (data) {
    var ags = (data.account && data.account.electricityAgreements) || [];
    for (var i = 0; i < ags.length; i++) {
      var meters = (ags[i].meterPoint && ags[i].meterPoint.meters) || [];
      for (var j = 0; j < meters.length; j++) {
        var devs = meters[j].smartDevices || [];
        if (devs.length && devs[0].deviceId) { localStorage.setItem("device_v1", devs[0].deviceId); return devs[0].deviceId; }
      }
    }
    throw new Error("No Home Mini found");
  });
}

/* ── App messages ─────────────────────────────────────────────────────────── */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function sendOnce(obj) { return new Promise(function (resolve, reject) { Pebble.sendAppMessage(obj, resolve, reject); }); }
function sendReliable(obj) {
  function attempt(n) {
    return sendOnce(obj).catch(function () {
      if (n <= 0) { console.log("octopus: gave up sending"); return; }
      return sleep(500).then(function () { return attempt(n - 1); });
    });
  }
  return attempt(12);
}
// payload p = { label, axis, a:{bars,total,unit}, b:{bars,total,unit}|null }  ->  AppMessage dict
function tracksMsg(p) {
  var msg = { STATUS: "ok", LABEL: p.label, AXIS: p.axis || "", A_BARS: p.a.bars.join(","), A_TOTAL: p.a.total, A_UNIT: p.a.unit };
  if (p.b) { msg.B_BARS = p.b.bars.join(","); msg.B_TOTAL = p.b.total; msg.B_UNIT = p.b.unit; }
  return msg;
}
function fmt(n, dp) { return (Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp)).toFixed(dp); }

/* ── Date helpers (local) ─────────────────────────────────────────────────── */
function startOfToday() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfWeek() { var d = new Date(); var diff = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff); }
function startOfMonth() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfYear() { var d = new Date(); return new Date(d.getFullYear(), 0, 1); }
var WD = ["S", "M", "T", "W", "T", "F", "S"];
var MO = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
var MO_FULL = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/* ── Telemetry: Live + Day ────────────────────────────────────────────────── */
function fetchTelemetry(deviceId, grouping, start, end) {
  var q = 'query { smartMeterTelemetry(deviceId:"' + deviceId + '", grouping:' + grouping +
    ', start:"' + start.toISOString() + '", end:"' + end.toISOString() + '"){ readAt demand consumptionDelta costDelta } }';
  return graphqlQuery(q).then(function (d) {
    var rows = (d.smartMeterTelemetry || []).slice();
    rows.sort(function (a, b) { return a.readAt < b.readAt ? -1 : (a.readAt > b.readAt ? 1 : 0); });
    return rows;
  });
}
// builders return { p } (tracks payload) or { nodata: label }
function buildLive(deviceId) {
  var end = new Date(), start = new Date(end.getTime() - 30 * 60000);
  return fetchTelemetry(deviceId, "ONE_MINUTE", start, end).then(function (rows) {
    var demand = [], wh = 0, latest = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].demand != null) { demand.push(Math.round(Number(rows[i].demand))); latest = Math.round(Number(rows[i].demand)); }
      if (rows[i].consumptionDelta != null) wh += Number(rows[i].consumptionDelta);
    }
    if (!demand.length) return { nodata: "LIVE" };
    function hm(iso) { return iso.substr(11, 5); }
    return { p: {
      label: "LIVE  " + Math.round(wh) + " Wh",
      axis: hm(rows[0].readAt) + "," + hm(rows[Math.floor(rows.length / 2)].readAt) + "," + hm(rows[rows.length - 1].readAt),
      a: { bars: demand, total: String(latest), unit: "W" }, b: null
    } };
  });
}
function buildDay(deviceId) {
  return fetchTelemetry(deviceId, "HALF_HOURLY", startOfToday(), new Date()).then(function (rows) {
    if (!rows.length) return { nodata: "TODAY" };
    var kwh = [], cost = [], i;
    for (i = 0; i < 48; i++) { kwh[i] = 0; cost[i] = 0; }
    var totKwh = 0, totCost = 0;
    for (i = 0; i < rows.length; i++) {
      var iso = rows[i].readAt;
      var slot = parseInt(iso.substr(11, 2), 10) * 2 + (parseInt(iso.substr(14, 2), 10) >= 30 ? 1 : 0);
      var k = (Number(rows[i].consumptionDelta) || 0) / 1000, c = (Number(rows[i].costDelta) || 0) / 100;
      if (slot >= 0 && slot < 48) { kwh[slot] += k; cost[slot] += c; }
      totKwh += k; totCost += c;
    }
    var kwhS = [], costS = [];
    for (i = 0; i < 48; i++) { kwhS.push(fmt(kwh[i], 3)); costS.push(fmt(cost[i], 3)); }
    return { p: { label: "TODAY", axis: "00,06,12,18",
      a: { bars: kwhS, total: fmt(totKwh, 2), unit: "kWh" },
      b: { bars: costS, total: fmt(totCost, 2), unit: "GBP" } } };
  });
}

/* ── Measurements: Week / Month / Year ────────────────────────────────────── */
function fetchMeasurements(freq, start, end) {
  var q = 'query($acc:String!,$start:DateTime!,$end:DateTime!){ account(accountNumber:$acc){ properties{ ' +
    'measurements(first:400, startAt:$start, endAt:$end, timezone:"Europe/London", ' +
    'utilityFilters:{ electricityFilters:{ readingFrequencyType:' + freq + ', readingDirection: CONSUMPTION } }){ ' +
    'edges{ node{ value ... on IntervalMeasurementType { startAt } metaData{ statistics{ costInclTax{ estimatedAmount } } } } } } } } }';
  return graphqlQuery(q, { acc: CONFIG.accountNumber, start: start.toISOString(), end: end.toISOString() }).then(function (d) {
    var props = (d.account && d.account.properties) || [], edges = [];
    for (var p = 0; p < props.length; p++) {
      var e = props[p].measurements && props[p].measurements.edges;
      if (e && e.length) { edges = e; break; }
    }
    return edges.map(function (e) {
      var stats = (e.node.metaData && e.node.metaData.statistics) || [], pence = 0;
      for (var i = 0; i < stats.length; i++) {
        if (stats[i].costInclTax && stats[i].costInclTax.estimatedAmount != null) pence += Number(stats[i].costInclTax.estimatedAmount);
      }
      return { start: e.node.startAt, kwh: Number(e.node.value) || 0, cost: pence / 100 };
    });
  });
}
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function buildHistory(view) {
  var now = new Date(), spec;
  if (view === "week") {
    spec = { freq: "DAY_INTERVAL", start: startOfWeek(), label: "THIS WEEK", slots: 7,
      axis: ["M", "T", "W", "T", "F", "S", "S"], idx: function (d) { return (d.getDay() + 6) % 7; } };
  } else if (view === "month") {
    var nd = daysInMonth(now.getFullYear(), now.getMonth()), labs = [];
    for (var z = 1; z <= nd; z++) labs.push(String(z));
    spec = { freq: "DAY_INTERVAL", start: startOfMonth(), label: MO_FULL[now.getMonth()] + " " + now.getFullYear(),
      slots: nd, axis: labs, idx: function (d) { return d.getDate() - 1; } };
  } else {
    spec = { freq: "MONTH_INTERVAL", start: startOfYear(), label: String(now.getFullYear()),
      slots: 12, axis: MO.slice(), idx: function (d) { return d.getMonth(); } };
  }

  return fetchMeasurements(spec.freq, spec.start, now).then(function (rows) {
    if (!rows.length) return { nodata: spec.label };
    var kwh = [], cost = [], i, totK = 0, totC = 0;
    for (i = 0; i < spec.slots; i++) { kwh[i] = 0; cost[i] = 0; }
    for (i = 0; i < rows.length; i++) {
      var dt = rows[i].start;
      var d = new Date(parseInt(dt.substr(0, 4), 10), parseInt(dt.substr(5, 2), 10) - 1, parseInt(dt.substr(8, 2), 10));
      var s = spec.idx(d);
      if (s >= 0 && s < spec.slots) { kwh[s] = rows[i].kwh; cost[s] = rows[i].cost; }
      totK += rows[i].kwh; totC += rows[i].cost;
    }
    var kwhS = [], costS = [];
    for (i = 0; i < spec.slots; i++) { kwhS.push(fmt(kwh[i], 2)); costS.push(fmt(cost[i], 2)); }
    return { p: { label: spec.label, axis: spec.axis.join(","),
      a: { bars: kwhS, total: fmt(totK, 1), unit: "kWh" },
      b: { bars: costS, total: fmt(totC, 2), unit: "GBP" } } };
  });
}

/* ── Mock ─────────────────────────────────────────────────────────────────── */
function mockSeq(n, base, spread) { var a = []; for (var i = 0; i < n; i++) a.push(base + ((i * 7) % 5) * spread); return a; }
function mockResult(view) {
  if (view === "live") {
    var d = mockSeq(30, 250, 90).map(function (x) { return String(Math.round(x)); });
    return { p: { label: "LIVE  180 Wh (mock)", axis: "12:00,12:15,12:30", a: { bars: d, total: "265", unit: "W" }, b: null } };
  }
  var specs = { day: [48, "00,06,12,18", "TODAY (mock)"], week: [7, "M,T,W,T,F,S,S", "THIS WEEK (mock)"],
    month: [30, "1,8,15,22,29", "JUN (mock)"], year: [12, "J,F,M,A,M,J,J,A,S,O,N,D", "2026 (mock)"] };
  var s = specs[view] || specs.day, k = mockSeq(s[0], 0.3, 0.25), kS = [], cS = [], tk = 0, tc = 0;
  for (var i = 0; i < k.length; i++) { kS.push(fmt(k[i], 3)); cS.push(fmt(k[i] * 0.28, 3)); tk += k[i]; tc += k[i] * 0.28; }
  return { p: { label: s[2], axis: s[1], a: { bars: kS, total: fmt(tk, 2), unit: "kWh" }, b: { bars: cS, total: fmt(tc, 2), unit: "GBP" } } };
}

/* ── Dispatch + cache ─────────────────────────────────────────────────────── */
var cache = {};                 // view -> { msg, at }
var TTL = { live: 15000, day: 300000, week: 900000, month: 1800000, year: 3600000 };
var inFlight = false;

function fetchView(view) {
  if (CONFIG.useMock) return Promise.resolve(mockResult(view));
  if (view === "live" || view === "day") return getDevice().then(function (id) { return view === "live" ? buildLive(id) : buildDay(id); });
  return buildHistory(view);
}

function load(view) {
  if (!CONFIG.useMock && (!CONFIG.apiKey || !CONFIG.accountNumber)) { sendReliable({ STATUS: "error", ERROR: "Set API key" }); return; }

  var c = cache[view], now = Date.now();
  if (c) {
    sendReliable(c.msg);                       // serve cached instantly
    if (now - c.at < (TTL[view] || 0)) return; // recent enough — no refetch
  } else {
    sendOnce({ STATUS: "loading" }).catch(function () {}); // primes the session
  }

  if (inFlight) return;
  inFlight = true;
  fetchView(view).then(function (r) {
    if (r.nodata) { if (!cache[view]) sendReliable({ STATUS: "nodata", LABEL: r.nodata }); return; }
    var msg = tracksMsg(r.p);
    cache[view] = { msg: msg, at: Date.now() };
    sendReliable(msg);
  }).catch(function (e) {
    if (!cache[view]) sendReliable({ STATUS: "error", ERROR: String((e && e.message) || e) }); // keep cache on error
  }).then(function () { inFlight = false; }, function () { inFlight = false; });
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */
Pebble.addEventListener("ready", function () {
  console.log("octopus: pkjs ready mock=" + CONFIG.useMock + " account=" + (CONFIG.accountNumber || "(none)") + " key=" + (CONFIG.apiKey ? "set" : "(none)"));
  load("live");
});
Pebble.addEventListener("appmessage", function (e) {
  var req = e.payload && e.payload.REQUEST;
  if (req === "live" || req === "day" || req === "week" || req === "month" || req === "year") load(req);
});

/* ── Settings page ────────────────────────────────────────────────────────── */
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function buildConfigPage(cur) {
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:-apple-system,Roboto,sans-serif;background:#140a2c;color:#fff;margin:0;padding:20px}' +
    'h2{color:#e850d0}label{display:block;margin:16px 0 4px;font-size:14px;color:#b99ad6}' +
    'input[type=text]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #402c60;' +
    'background:#1f1140;color:#fff;font-size:16px}.row{display:flex;align-items:center;margin-top:16px}' +
    '.row input{margin-right:8px}button{margin-top:24px;width:100%;padding:14px;border:0;border-radius:24px;' +
    'background:#7b5cff;color:#fff;font-size:16px;font-weight:bold}</style></head><body>' +
    '<h2>⚡ Octopus Energy</h2>' +
    '<label>API key</label><input type="text" id="apiKey" value="' + esc(cur.apiKey) + '" placeholder="sk_live_…">' +
    '<label>Account number</label><input type="text" id="accountNumber" value="' + esc(cur.accountNumber) + '" placeholder="A-AB1234CD">' +
    '<div class="row"><input type="checkbox" id="useMock"' + (cur.useMock ? " checked" : "") + '><label style="margin:0">Use demo data</label></div>' +
    '<button onclick="save()">Save</button>' +
    '<p style="font-size:12px;color:#9a7fc0">API key: Octopus dashboard → Developer settings → API access.</p>' +
    '<script>function save(){var d={apiKey:document.getElementById("apiKey").value.trim(),' +
    'accountNumber:document.getElementById("accountNumber").value.trim(),' +
    'useMock:document.getElementById("useMock").checked};' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(d));}</script></body></html>';
  return "data:text/html," + encodeURIComponent(html);
}
Pebble.addEventListener("showConfiguration", function () { Pebble.openURL(buildConfigPage(CONFIG)); });
Pebble.addEventListener("webviewclosed", function (e) {
  if (!e || !e.response) return;
  var data;
  try { data = JSON.parse(decodeURIComponent(e.response)); } catch (err) { return; }
  var settings = { useMock: !!data.useMock };
  if (typeof data.apiKey === "string") settings.apiKey = data.apiKey;
  if (typeof data.accountNumber === "string") settings.accountNumber = data.accountNumber;
  localStorage.setItem("settings", JSON.stringify(settings));
  localStorage.removeItem("device_v1");
  krakenToken = null;
  cache = {};
  CONFIG = loadConfig();
  load("live");
});
