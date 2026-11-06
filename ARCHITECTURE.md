# Architecture

Telegram API Diff uses a dependency-free Node.js engine and a static JavaScript dashboard.

## Runtime

- Node.js 22 or newer.
- No third-party runtime packages. HTTP requests use the built-in Fetch API.
- Tests use the built-in Node.js test runner.

## Core modules

- `src/core.js` fetches Telegram's official schema and layer timeline, validates declarations, compares snapshots, renders Markdown reports, and handles atomic storage and GitHub Actions outputs.
- `src/normalize.js` applies conservative normalization rules to Telegram production web resources.
- `src/crawler.js` discovers Telegram-owned HTML pages and static-resource URLs with bounded requests, robots.txt checks, and redirect restrictions. It does not yet download or archive resource bodies.
- `src/index.js` provides the `update`, `check`, and `crawl` CLI commands.
- `site/app.js` is the browser-side dashboard controller and does not import Node-only modules.

## Reference-inspired normalization

The normalization rules follow the behavior documented by
[glebxdlolreal/prodserverchangesall](https://github.com/glebxdlolreal/prodserverchangesall):

- remove volatile `<time>` elements;
- remove page-generation HTML comments;
- normalize IP addresses ending in `:8888`;
- normalize `hash`, `token`, `passport_ssid`, and `nonce` query values;
- remove numeric JavaScript/CSS cache-buster suffixes;
- normalize `sig=` and `se=` signature values;
- ignore top-level `hash` and `ton_usd_rate` fields in `help.getAppConfig.json`.

For app-config JSON, similarly named nested fields are preserved. The reference repository is a behavioral reference only; its source files, snapshots, and assets are not copied.

## Data compatibility

The existing `snapshots/*.json` and `reports/*.md` formats remain readable by the dashboard. Failed downloads, invalid JSON, empty schemas, and malformed declarations are errors and never replace the baseline.

The scheduled workflow runs `node src/index.js update`. It writes a dated snapshot, `snapshots/latest.json`, a dated report, and `reports/latest.md`. It also writes single-line outputs to `GITHUB_OUTPUT` for optional Telegram notifications and release generation.

## Local development

    npm test
    node src/index.js update
    node src/index.js check
    node src/index.js crawl

Pass `--schema-url`, `--root`, and `--timeout` to override defaults.
