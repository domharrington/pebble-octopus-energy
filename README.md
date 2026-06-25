# Octopus Energy for Pebble

A Pebble **watchapp** (not a watchface) that shows your home electricity usage as
a bar chart, using the [Octopus Energy API](https://developer.octopus.energy/).
Built with **Alloy** (Pebble's JavaScript framework, powered by Moddable XS).

Targets **emery** (Pebble Time 2) and **gabbro** (Pebble Round 2).

## Views & controls

- **Live** — near-real-time watts from your Octopus **Home Mini** (GraphQL
  `smartMeterTelemetry`), polled every ~30s *only while this view is open*.
- **Day** — most recent day of hourly consumption (kWh). The REST feed lags
  ~24–48h, so the latest day with data is shown, labelled with its date.
- **Week / Month / Year** — kWh aggregated by day (week, month) or by month
  (year), via the REST `group_by` parameter.

Buttons: **UP/DOWN** cycle through the views · **SELECT** refreshes · **BACK** exits
(which also stops live polling — its timer dies with the app).

## Settings

The app is **configurable** from the phone's Pebble app (gear icon → Settings).
The page collects your API key, account number, and a demo-data toggle, and saves
them to `localStorage` (the highest-priority config layer). The API key stays on
the phone. The page is a self-contained `data:` URL, so no server is needed.

## How it works

```
src/embeddedjs/main.js   Watch UI — Poco bar chart, view switching, live poll timer
src/pkjs/index.js        Phone — Octopus REST + GraphQL, normalises, sends to watch
src/pkjs/config.js       Committed config defaults (no secrets)
src/pkjs/config.local.js Your personal secrets (gitignored, optional)
```

The phone side (`pkjs`) does all networking — **your API key never reaches the
watch**. It distils the response to ~24 numbers and sends them over App Messages;
the watch just draws.

## Configuration

Credentials resolve in this order (later layers win):

1. **`config.js`** — committed defaults. Ships with `useMock: true` so the app
   renders synthetic data with no credentials.
2. **`config.local.js`** — your personal keys, gitignored. This is the
   "local secrets" file for personal builds.
3. **`localStorage["settings"]`** — written by an on-phone Settings page in a
   future distributed build (see Roadmap).

### Personal setup

```sh
cp src/pkjs/config.local.example.js src/pkjs/config.local.js
# edit config.local.js: set apiKey, accountNumber, useMock: false
```

- **apiKey** — Octopus Dashboard → Developer settings → API access (`sk_live_…`)
- **accountNumber** — e.g. `A-AB1234CD`

The app auto-discovers your MPAN + meter serial (and Home Mini device ID) from
the account; export/solar meter-points are skipped. The REST consumption feed
lags ~24–48h, so the Day view shows the most recent day that has data.

## Building & running

A `Makefile` wraps the common commands (run `make` for the list):

```sh
make run                 # build + launch the Pebble Time 2 (emery) emulator
make logs                # stream watch + pkjs logs
make config              # open the Settings page in the emulator
make deploy PHONE=<ip>   # install onto your real watch (see below)
```

`pebble` itself comes from the SDK (`uv tool install pebble-tool`) and lives in
`~/.local/bin` — make sure that's on your `PATH`.

## Deploying to your Pebble Time 2

The watch installs over Bluetooth via your phone:

1. Install the **Pebble** companion app (Core Devices / Rebble) and pair your
   Time 2.
2. In the app, enable the **Developer Connection** — it shows your phone's IP.
3. Put your computer and phone on the **same Wi-Fi**, then:
   ```sh
   make deploy PHONE=192.168.1.42      # your phone's IP
   ```
   (equivalently `pebble install --phone <ip> --logs`). The app appears in the
   watch's app list with the octopus icon.
4. Set your API key / account number on the watch via the companion app's
   **Settings** (gear icon), or bake them into `config.local.js` before building.

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
