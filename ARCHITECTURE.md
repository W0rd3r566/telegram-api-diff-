# Architecture and migration plan

## Current layout

`engine/` is the new Rust core.

- `schema.rs` validates Telegram TL schema payloads and sorts declarations deterministically.
- `diff.rs` compares constructors, methods, types, API layer, and other top-level metadata.
- `normalize.rs` removes known volatile fragments from production web resources and normalizes the selected app-config fields.

`site/` is the static GitHub Pages dashboard.

- `index.html` contains the page structure and styles.
- `app.js` contains the dashboard behavior and data loading.

`src/telegram_api_diff/` is the existing Python implementation. It remains the production runner until the Rust CLI and scheduled workflow reach feature parity.

## Production resource normalization

The normalization behavior is based on the documented process in
[glebxdlolreal/prodserverchangesall](https://github.com/glebxdlolreal/prodserverchangesall).

The Rust normalizer currently handles:

- volatile `<time>` elements;
- generated HTML comments containing page-generation time;
- IP-and-port values ending in `:8888`;
- volatile query values: `hash`, `token`, `passport_ssid`, and `nonce`;
- numeric cache-buster suffixes on JavaScript and CSS assets;
- `sig=` and `se=` signature values;
- top-level `hash` and `ton_usd_rate` fields in `help.getAppConfig.json`.

The JSON config normalization deliberately removes only top-level fields. Nested fields with the same names are preserved to avoid deleting potentially meaningful application data.

The reference repository has no published license file. This project uses its public documentation as a behavioral reference and does not copy its source files, snapshots, or assets.

## Migration sequence

1. Port schema validation, canonicalization, and structured diffing to Rust.
2. Port report generation and the `update` / `check` CLI while preserving the current JSON snapshot format and Markdown report semantics.
3. Add the production-resource collector around an explicit, reviewable resource manifest. Keep requests bounded, use timeouts, and fail safely on unexpected responses.
4. Connect the Rust runner to the existing GitHub Actions workflow only after parity tests pass.
5. Extend the JavaScript dashboard to display web-resource history alongside MTProto schema history.
6. Remove the Python runner only after the Rust runner has passed equivalent workflow runs and the existing historical data remains readable.

## Compatibility rules

- Never overwrite `main` during the migration; use the rewrite branch and reviewable pull requests.
- Keep existing `snapshots/` and `reports/` readable.
- Treat failed downloads, invalid JSON, and empty payloads as errors. They must never replace a valid baseline.
- Normalize only documented volatile values. Do not broadly strip content just because it changes often.
- Keep generated snapshots and the dashboard's public data format stable unless a migration explicitly updates both producer and consumer.
