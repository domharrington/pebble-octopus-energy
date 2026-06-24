/*
 * Default configuration — SAFE TO COMMIT (no secrets here).
 *
 * Resolution order (highest priority last), see index.js loadConfig():
 *   1. this file (committed defaults, mock mode on)
 *   2. src/pkjs/config.local.js  (gitignored — your personal keys; see config.local.example.js)
 *   3. on-phone Settings page     (localStorage "settings" — for distributed builds)
 */
module.exports = {
  apiKey: "",
  accountNumber: "",
  useMock: true
};
