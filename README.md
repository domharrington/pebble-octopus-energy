# Octopus Energy for Pebble

A Pebble **watchapp** (not a watchface) that shows your home electricity usage —
live power plus historical kWh and **£ cost** — using the Octopus Energy
[Kraken GraphQL API](https://developer.octopus.energy/). Built with **Alloy**
(Pebble's JavaScript framework, powered by Moddable XS).

Targets **emery** (Pebble Time 2) and **gabbro** (Pebble Round 2).

## Views & controls

- **Live** — near-real-time watts from your Octopus **Home Mini**
  (`smartMeterTelemetry`, 1-minute over the last 30 min), with Wh used and a
  time axis. Polled every ~30s *only while this view is open*.
- **Day** — today so far, half-hourly (telemetry, fresh).
- **Week / Month / Year** — this week (Mon–Sun), this month, this year, via the
  `measurements` query (one call each).

Every energy view carries **both kWh and £**.

Buttons: **UP/DOWN** cycle views · **SELECT** toggles **kWh ⟷ £** · **BACK** exits.
The app **remembers your last view and kWh/£ choice** across launches.

## How it works

```
src/embeddedjs/main.js   Watch UI — Poco bar chart, view switching, live poll timer
src/pkjs/index.js        Phone — Kraken GraphQL, normalises, sends to watch
src/pkjs/config.js       Committed config defaults (no secrets)
src/pkjs/config.local.js Your personal secrets (gitignored, optional)
resources/menu_icon.png  App launcher icon (octopus)
```

The phone side (`pkjs`) does all networking — **your API key never reaches the
watch**. Per view it sends two compact series (kWh + £); the watch draws one and
**SELECT toggles** between them instantly. Data sources:

- **Live / Day** → `smartMeterTelemetry` (Home Mini — fresh, includes cost)
- **Week / Month / Year** → `measurements` (DAY/DAY/MONTH interval — includes cost)

**Per-view caching:** switching to a recently-seen view is served instantly; a
stale view is shown immediately and refreshed in the background (TTLs: Live 15s,
Day 5m, Week 15m, Month 30m, Year 60m).

## Settings

The app is **configurable** from the phone's Pebble app (gear icon → Settings):
API key, account number, and a demo-data toggle. It saves to `localStorage`
(highest-priority config layer); the API key stays on the phone. The page is a
self-contained `data:` URL, so no server is needed.

## Configuration

Credentials resolve in this order (later layers win):

1. **`config.js`** — committed defaults (`useMock: true`, renders demo data).
2. **`config.local.js`** — your personal keys, gitignored.
3. **`localStorage["settings"]`** — written by the on-phone Settings page.

### Personal setup

```sh
cp src/pkjs/config.local.example.js src/pkjs/config.local.js
# edit config.local.js: set apiKey, accountNumber, useMock: false
```

- **apiKey** — Octopus dashboard → Developer settings → API access (`sk_live_…`)
- **accountNumber** — e.g. `A-AB1234CD`

The app auto-discovers your Home Mini device, MPAN and meter from the account
(export/solar meter-points are skipped).

## Building & running

A `Makefile` wraps the common commands (run `make` for the list):

```sh
make run     # build + launch the Pebble Time 2 (emery) emulator with logs
make logs    # stream watch + pkjs logs
make config  # open the Settings page in the emulator
make pbw     # build the .pbw and reveal it for sideloading (no cloud)
make deploy  # install to your watch via the CloudPebble dev connection
```

`pebble` comes from the SDK (`uv tool install pebble-tool`) and lives in
`~/.local/bin` — make sure that's on your `PATH`.

## Deploying to your Pebble Time 2

Installs go to the watch **over Bluetooth via your phone** (the phone is also
needed at runtime — the API calls run in PebbleKit JS on the phone). USB is
charge-only and can't install apps.

- **No cloud — sideload the `.pbw`:** `make pbw`, then get `build/octopus.pbw`
  onto your phone (AirDrop; on Android use Rebble's *Sideload Helper*) and open
  it in the Pebble app. No login/IP needed.
- **CloudPebble dev connection** (live install + logs): enable **Dev Connection**
  in the app (Devices → ⋯), `make login` once, then `make deploy`.
- **Local Wi-Fi** (only if the app shows a Server IP): `make deploy-ip PHONE=<ip>`.

Set your API key / account number via the app's **Settings**, or bake them into
`config.local.js` before building.

## Roadmap

- **Gas** alongside electricity (separate meter point / GraphQL filter).
- **Publish to the appstore** (future) — sideloading works today; to get a store
  listing with screenshots, via the [Rebble dev portal](https://dev-portal.rebble.io/):
  1. Log in → *Add a Watchapp*; enter title, source URL, support email, category.
  2. Upload large + small icons.
  3. *Add a release* → upload the `.pbw` → publish the release.
  4. Per platform, create an *Asset Collection*: description, up to 5 screenshots,
     up to 3 header images, a marketing banner.
  5. *Publish* (public or private) for a shareable appstore link.
