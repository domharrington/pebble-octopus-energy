/*
 * Octopus Energy — phone-side (PebbleKit JS).
 *
 * Runs on your phone. Does all the networking (your API key never leaves the
 * phone), normalises the response to a tiny payload, and sends it to the watch
 * via App Messages.
 *
 * Note on style: the pkjs bundler is ES5-only, so no async/await or arrow
 * functions here — but Promises work at runtime, so XHR is wrapped in a Promise
 * once and the logic reads as flat .then() chains instead of nested callbacks.
 */

/* ── Configuration ───────────────────────────────────────────────────────────
 * Don't put credentials here. Resolution order (highest priority last):
 *   1. config.js               committed defaults (mock mode, no secrets)
 *   2. config.local.js         gitignored personal keys (see config.local.example.js)
 *   3. localStorage "settings" written by the on-phone Settings page (distributed builds)
 */
function merge(target, src) {
  if (!src) return target;
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined && src[k] !== "") {
      target[k] = src[k];
    }
  }
  return target;
}

// require() that returns {} instead of throwing when the module is absent,
// so a fresh clone without config.local.js still builds and runs.
function requireOptional(path) {
  try { return require(path); } catch (e) { return {}; }
}

function loadConfig() {
  var cfg = { apiKey: "", accountNumber: "", useMock: true };
  try { merge(cfg, require("./config")); } catch (e) {}
  merge(cfg, requireOptional("./config.local"));
  try {
    var stored = localStorage.getItem("settings");
    if (stored) merge(cfg, JSON.parse(stored));
  } catch (e) {}
  return cfg;
}

var CONFIG = loadConfig();
var BASE = "https://api.octopus.energy/v1";

/* ── Auth ──────────────────────────────────────────────────────────────────── */
// base64 (btoa isn't guaranteed in PebbleKit JS)
function b64encode(input) {
  var k = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var out = "", c1, c2, c3, e1, e2, e3, e4, i = 0;
  while (i < input.length) {
    c1 = input.charCodeAt(i++); c2 = input.charCodeAt(i++); c3 = input.charCodeAt(i++);
    e1 = c1 >> 2;
    e2 = ((c1 & 3) << 4) | (c2 >> 4);
    e3 = ((c2 & 15) << 2) | (c3 >> 6);
    e4 = c3 & 63;
    if (isNaN(c2)) { e3 = e4 = 64; } else if (isNaN(c3)) { e4 = 64; }
    out += k.charAt(e1) + k.charAt(e2) + k.charAt(e3) + k.charAt(e4);
  }
  return out;
}
function authHeader() { return "Basic " + b64encode(CONFIG.apiKey + ":"); }

/* ── HTTP (Promise-wrapped XHR) ───────────────────────────────────────────── */
function httpGet(url) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.setRequestHeader("Authorization", authHeader());
    xhr.timeout = 15000;
    xhr.onload = function () { resolve({ status: xhr.status, body: xhr.responseText }); };
    xhr.onerror = function () { reject(new Error("network error")); };
    xhr.ontimeout = function () { reject(new Error("timed out")); };
    xhr.send();
  });
}

function getJSON(url) {
  return httpGet(url).then(function (res) {
    if (res.status === 401 || res.status === 403) throw new Error("Bad API key");
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    return JSON.parse(res.body);
  });
}

/* ── App messages ─────────────────────────────────────────────────────────── */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function sendOnce(obj) {
  return new Promise(function (resolve, reject) {
    Pebble.sendAppMessage(obj, resolve, reject);
  });
}

// Retry until the watch's channel accepts the message. The first attempt also
// kicks off the AppMessage session handshake when the app has just launched.
function sendReliable(obj) {
  function attempt(n) {
    return sendOnce(obj).catch(function () {
      if (n <= 0) { console.log("octopus: gave up sending after retries"); return; }
      return sleep(500).then(function () { return attempt(n - 1); });
    });
  }
  return attempt(12);
}

/* ── Octopus data ─────────────────────────────────────────────────────────── */
function getMeter() {
  var cached = localStorage.getItem("meter_v2");
  if (cached) return Promise.resolve(JSON.parse(cached));

  return getJSON(BASE + "/accounts/" + encodeURIComponent(CONFIG.accountNumber) + "/").then(function (data) {
    var props = data.properties || [];
    var found = null;
    for (var p = 0; p < props.length && !found; p++) {
      var emps = props[p].electricity_meter_points || [];
      for (var m = 0; m < emps.length && !found; m++) {
        var meters = emps[m].meters || [];
        // Skip export (solar) meter-points; we want import consumption.
        if (emps[m].mpan && meters.length && !emps[m].is_export) {
          found = { mpan: emps[m].mpan, serial: meters[0].serial_number };
        }
      }
    }
    if (!found) throw new Error("No electricity meter found");
    localStorage.setItem("meter_v2", JSON.stringify(found));
    console.log("octopus: meter mpan…" + found.mpan.slice(-4) + " serial…" + String(found.serial).slice(-4));
    return found;
  });
}

var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
var WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// "2026-06-21" -> "SAT 21 JUN"
function formatDateLabel(ymd) {
  var parts = ymd.split("-");
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
  return WEEKDAYS[d.getDay()] + " " + Number(parts[2]) + " " + MONTHS[Number(parts[1]) - 1];
}

// The REST feed lags ~24-48h, so instead of assuming "today" we fetch the most
// recent hourly data and show the latest day that actually has readings.
function fetchRecentDay(meter) {
  var url = BASE + "/electricity-meter-points/" + meter.mpan + "/meters/" + meter.serial +
    "/consumption/?group_by=hour&order_by=-period&page_size=72"; // ~3 days of hourly buckets

  return getJSON(url).then(function (data) {
    var results = data.results || []; // newest first
    var byDate = {}, order = [];
    for (var i = 0; i < results.length; i++) {
      var iso = results[i].interval_start || "";
      var ymd = iso.substr(0, 10);
      var hh = parseInt(iso.substr(11, 2), 10);
      if (!ymd || isNaN(hh)) continue;
      if (!byDate[ymd]) { byDate[ymd] = []; for (var z = 0; z < 24; z++) byDate[ymd][z] = 0; order.push(ymd); }
      byDate[ymd][hh] += Number(results[i].consumption) || 0;
    }

    // Pick the date with the most populated hours; ties resolve to the most
    // recent (order is newest-first, and we only replace on a strictly higher count).
    var best = null, bestCount = -1;
    for (var d = 0; d < order.length; d++) {
      var c = 0, hrs = byDate[order[d]];
      for (var h = 0; h < 24; h++) if (hrs[h] > 0) c++;
      if (c > bestCount) { bestCount = c; best = order[d]; }
    }
    console.log("octopus: recent day=" + best + " hoursWithData=" + bestCount + " daysSeen=" + order.length);
    if (!best) return null;
    return { label: formatDateLabel(best), hours: byDate[best] };
  });
}

function sumHours(hours) {
  var total = 0;
  for (var j = 0; j < hours.length; j++) total += hours[j];
  return total;
}

function sendDay(label, hours) {
  var parts = [];
  for (var i = 0; i < hours.length; i++) parts.push((hours[i] || 0).toFixed(3));
  var total = sumHours(hours);
  if (total === 0) return sendReliable({ STATUS: "nodata", LABEL: label });
  return sendReliable({
    STATUS: "ok",
    LABEL: label,
    TOTAL: total.toFixed(2),
    UNIT: "kWh",
    BARS: parts.join(",")
  });
}

// Synthetic day with a morning peak, roughly like the app screenshots.
function mockHours() {
  return [0.12, 0.10, 0.09, 0.55, 0.30, 0.45, 0.95, 0.70, 0.40, 0.35, 0.30, 0.20,
          0.18, 0.16, 0.15, 0.17, 0.22, 0.30, 0.42, 0.38, 0.30, 0.25, 0.20, 0.15];
}

// Aggregated buckets (week/month/year) via group_by. Returns the most recent
// `count` buckets in chronological order as a kWh array.
function fetchAggregate(meter, groupBy, count) {
  var url = BASE + "/electricity-meter-points/" + meter.mpan + "/meters/" + meter.serial +
    "/consumption/?group_by=" + groupBy + "&order_by=-period&page_size=" + (count + 3);
  return getJSON(url).then(function (data) {
    var results = (data.results || []).slice(0, count); // newest first
    results.reverse(); // -> chronological
    var bars = [];
    for (var i = 0; i < results.length; i++) bars.push(Number(results[i].consumption) || 0);
    return bars;
  });
}

// view -> how to aggregate. "day" is handled separately (hourly, best recent day).
var HISTORY = {
  week:  { groupBy: "day",   count: 7,  label: "LAST 7 DAYS" },
  month: { groupBy: "day",   count: 30, label: "LAST 30 DAYS" },
  year:  { groupBy: "month", count: 12, label: "LAST 12 MONTHS" }
};

function mockBars(n, base) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(base + ((i * 7) % 5) * base * 0.3);
  return out;
}

var inFlight = false; // guards against overlapping/duplicate loads

// Handles day/week/month/year.
function loadHistory(view) {
  if (inFlight) return;
  inFlight = true;
  function finish() { inFlight = false; }

  var spec = HISTORY[view]; // undefined for "day"

  if (CONFIG.useMock) {
    if (view === "day") sendDay("TODAY (mock)", mockHours()).then(finish, finish);
    else sendDay(spec.label + " (mock)", mockBars(spec.count, view === "year" ? 250 : 8)).then(finish, finish);
    return;
  }
  if (!CONFIG.apiKey || !CONFIG.accountNumber) {
    sendReliable({ STATUS: "error", ERROR: "Set API key in pkjs" }).then(finish, finish);
    return;
  }

  sendOnce({ STATUS: "loading" }).catch(function () {}); // best-effort; also primes the session

  getMeter().then(function (meter) {
    if (view === "day") {
      return fetchRecentDay(meter).then(function (day) {
        if (!day) return sendReliable({ STATUS: "nodata", LABEL: "NO DATA" });
        return sendDay(day.label, day.hours);
      });
    }
    return fetchAggregate(meter, spec.groupBy, spec.count).then(function (bars) {
      return sendDay(spec.label, bars);
    });
  }).catch(function (e) {
    return sendReliable({ STATUS: "error", ERROR: String((e && e.message) || e) });
  }).then(finish, finish);
}

function loadDay() { loadHistory("day"); }

/* ── Live (Home Mini, GraphQL) ────────────────────────────────────────────── */
var GRAPHQL = "https://api.octopus.energy/v1/graphql/";
var krakenToken = null; // short-lived JWT, re-minted on auth failure

function graphqlRaw(query, token) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", GRAPHQL, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    if (token) xhr.setRequestHeader("Authorization", token); // raw token, no prefix
    xhr.timeout = 15000;
    xhr.onload = function () {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch (e) { reject(new Error("Bad GraphQL JSON")); }
    };
    xhr.onerror = function () { reject(new Error("network error")); };
    xhr.ontimeout = function () { reject(new Error("timed out")); };
    xhr.send(JSON.stringify({ query: query }));
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

// Run an authenticated query; if the token has expired, re-mint once and retry.
function graphqlQuery(query) {
  return getToken().then(function (token) {
    return graphqlRaw(query, token).then(function (res) {
      if (res.errors) {
        var msg = res.errors[0].message || "GraphQL error";
        if (/token|auth|signature|expire|jwt|permission/i.test(msg)) {
          krakenToken = null;
          return getToken().then(function (t2) { return graphqlRaw(query, t2); }).then(function (r2) {
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
          '{ electricityAgreements(active: true) { meterPoint { meters(includeInactive: false) ' +
          '{ smartDevices { deviceId } } } } } }';
  return graphqlQuery(q).then(function (data) {
    var ags = (data.account && data.account.electricityAgreements) || [];
    for (var i = 0; i < ags.length; i++) {
      var meters = (ags[i].meterPoint && ags[i].meterPoint.meters) || [];
      for (var j = 0; j < meters.length; j++) {
        var devs = meters[j].smartDevices || [];
        if (devs.length && devs[0].deviceId) {
          localStorage.setItem("device_v1", devs[0].deviceId);
          console.log("octopus: home mini device …" + String(devs[0].deviceId).slice(-6));
          return devs[0].deviceId;
        }
      }
    }
    throw new Error("No Home Mini found");
  });
}

function isoMinutesAgo(min) { return new Date(Date.now() - min * 60000).toISOString(); }

// demand (watts) over the last few minutes; latest reading is the headline number.
function sendLive(points) {
  if (!points.length) return sendReliable({ STATUS: "nodata", LABEL: "LIVE" });
  var parts = [], i;
  for (i = 0; i < points.length; i++) parts.push(String(Math.round(points[i])));
  return sendReliable({
    STATUS: "ok",
    LABEL: "LIVE",
    TOTAL: String(Math.round(points[points.length - 1])),
    UNIT: "W",
    BARS: parts.join(",")
  });
}

function mockLive() {
  var out = [], v = 300;
  for (var i = 0; i < 40; i++) { v += (((i * 37) % 11) - 5) * 20; if (v < 60) v = 60; out.push(v); }
  return out;
}

function loadLive() {
  if (inFlight) return;
  inFlight = true;
  function finish() { inFlight = false; }

  if (CONFIG.useMock) { sendLive(mockLive()).then(finish, finish); return; }
  if (!CONFIG.apiKey || !CONFIG.accountNumber) {
    sendReliable({ STATUS: "error", ERROR: "Set API key in pkjs" }).then(finish, finish);
    return;
  }

  getDevice().then(function (deviceId) {
    var q = 'query { smartMeterTelemetry(deviceId: "' + deviceId + '", grouping: TEN_SECONDS, ' +
            'start: "' + isoMinutesAgo(8) + '", end: "' + new Date().toISOString() + '") ' +
            '{ readAt demand } }';
    return graphqlQuery(q);
  }).then(function (data) {
    var rows = data.smartMeterTelemetry || [];
    // Sort oldest→newest by readAt and keep readings that report demand.
    rows.sort(function (a, b) { return (a.readAt < b.readAt) ? -1 : (a.readAt > b.readAt ? 1 : 0); });
    var demand = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].demand !== null && rows[i].demand !== undefined) demand.push(Number(rows[i].demand));
    }
    console.log("octopus: live rows=" + rows.length + " withDemand=" + demand.length);
    return sendLive(demand);
  }).catch(function (e) {
    return sendReliable({ STATUS: "error", ERROR: String((e && e.message) || e) });
  }).then(finish, finish);
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */
Pebble.addEventListener("ready", function () {
  console.log("octopus: pkjs ready mock=" + CONFIG.useMock +
    " account=" + (CONFIG.accountNumber || "(none)") +
    " key=" + (CONFIG.apiKey ? "set" : "(none)"));
  // Drive the initial load (default view = live). sendReliable retries until the
  // watch's channel is open. Once the watch has received this, it can send its
  // own requests (poll/refresh/switch).
  loadLive();
});

Pebble.addEventListener("appmessage", function (e) {
  // Only act on explicit view requests; ignore the empty handshake message.
  var req = e.payload && e.payload.REQUEST;
  if (req === "live") loadLive();
  else if (req === "day" || req === "week" || req === "month" || req === "year") loadHistory(req);
});

/* ── Settings page (on-phone configuration) ───────────────────────────────────
 * Self-contained page (a data: URL, so no hosting needed). Saving writes to
 * localStorage "settings", which loadConfig() treats as highest priority — the
 * same layer a future Clay page would use. The API key stays on the phone.
 */
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildConfigPage(cur) {
  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:-apple-system,Roboto,sans-serif;background:#140a2c;color:#fff;margin:0;padding:20px}' +
    'h2{color:#e850d0}label{display:block;margin:16px 0 4px;font-size:14px;color:#b99ad6}' +
    'input[type=text]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #402c60;' +
    'background:#1f1140;color:#fff;font-size:16px}.row{display:flex;align-items:center;margin-top:16px}' +
    '.row input{margin-right:8px}button{margin-top:24px;width:100%;padding:14px;border:0;border-radius:24px;' +
    'background:#7b5cff;color:#fff;font-size:16px;font-weight:bold}a{color:#e850d0}</style></head><body>' +
    '<h2>⚡ Octopus Energy</h2>' +
    '<label>API key</label><input type="text" id="apiKey" value="' + esc(cur.apiKey) + '" placeholder="sk_live_…">' +
    '<label>Account number</label><input type="text" id="accountNumber" value="' + esc(cur.accountNumber) + '" placeholder="A-AB1234CD">' +
    '<div class="row"><input type="checkbox" id="useMock"' + (cur.useMock ? " checked" : "") + '><label style="margin:0">Use demo data</label></div>' +
    '<button onclick="save()">Save</button>' +
    '<p style="font-size:12px;color:#9a7fc0">Get your API key from your Octopus dashboard → Developer settings → API access.</p>' +
    '<script>function save(){var d={apiKey:document.getElementById("apiKey").value.trim(),' +
    'accountNumber:document.getElementById("accountNumber").value.trim(),' +
    'useMock:document.getElementById("useMock").checked};' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(d));}</script>' +
    '</body></html>';
  return "data:text/html," + encodeURIComponent(html);
}

Pebble.addEventListener("showConfiguration", function () {
  console.log("octopus: showConfiguration -> opening settings page");
  Pebble.openURL(buildConfigPage(CONFIG));
});

Pebble.addEventListener("webviewclosed", function (e) {
  if (!e || !e.response) return; // user cancelled
  var data;
  try { data = JSON.parse(decodeURIComponent(e.response)); } catch (err) { return; }

  var settings = { useMock: !!data.useMock };
  if (typeof data.apiKey === "string") settings.apiKey = data.apiKey;
  if (typeof data.accountNumber === "string") settings.accountNumber = data.accountNumber;
  localStorage.setItem("settings", JSON.stringify(settings));

  // Account/key may have changed — drop cached lookups and tokens.
  localStorage.removeItem("meter_v2");
  localStorage.removeItem("device_v1");
  krakenToken = null;
  CONFIG = loadConfig();
  console.log("octopus: settings saved mock=" + CONFIG.useMock +
    " account=" + (CONFIG.accountNumber || "(none)") + " key=" + (CONFIG.apiKey ? "set" : "(none)"));

  loadLive(); // refresh with the new settings (watch re-syncs on its next poll too)
});
