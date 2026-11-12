# Architecture

Telegram API Diff uses a dependency-free Node.js engine and a static JavaScript dashboard.

## Runtime

- Node.js 22 or newer.
- No third-party runtime packages. HTTP requests use the built-in Fetch API.
- Tests use the built-in Node.js test runner.

## Core modules

- `src/core.js` fetches Telegram's official schema and layer timeline, validates declarations, compares snapshots, renders Markdown reports, and handles atomic storage and GitHub Actions outputs.
- `src/normalize.js` applies conservative normalization rules to Telegram production web resources.
- `src/crawler.js` discovers Telegram-owned HTML pages and static-resource URLs with bounded requests, robots.txt checks, and redirect restrictions.
- `src/resource-collector.js` fetches tracked pages and resources, validates redirects and robots.txt, applies validators and byte budgets, normalizes text, and archives normalized content by SHA-256.
- `src/index.js` provides the `update`, `check`, `crawl`, and `collect` CLI commands.
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

The MTProto workflow runs `node src/index.js update`. The resource workflow runs `crawl` followed by `collect`; its manifests live in `resource_snapshots/`, Markdown reports in `resource_reports/`, and content-addressed objects in `resource_objects/`. Resource collection rotates through large URL inventories, uses ETag/Last-Modified validators, and never treats a failed fetch as a deletion.

## Local development

    npm test
    node src/index.js update
    node src/index.js check
    node src/index.js crawl
    node src/index.js collect

Pass `--schema-url`, `--root`, `--timeout`, and the resource-collector byte/count options to override defaults.
