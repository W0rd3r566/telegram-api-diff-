# Telegram API Diff

Track changes in Telegram's official MTProto TL schema and discover changes in Telegram's public web resources with a dependency-free Node.js engine and a JavaScript dashboard.

The MTProto tracker downloads Telegram's machine-readable schema, compares it with previous snapshots, stores versioned JSON data, and writes Markdown reports. The resource crawler discovers Telegram pages and static-resource URLs. A separate collector fetches those URLs, removes documented volatile data, hashes normalized content, and stores each unique body once. The runner uses Node's built-in Fetch API and filesystem modules. No npm runtime dependencies are required.

## Features

- **Official MTProto source:** [Telegram's machine-readable TL schema](https://core.telegram.org/schema/json), with the current API layer read from [Telegram's schema documentation](https://core.telegram.org/schema).
- **Structured MTProto change detection:** added, removed, and modified declarations, plus changes to the API layer and other top-level metadata.
- **Snapshot history:** dated JSON snapshots in `snapshots/`, with `snapshots/latest.json` as the current baseline.
- **Detailed Markdown reports:** dated reports in `reports/` and `reports/latest.md`, including field and parameter-level changes.
- **Telegram resource discovery:** bounded crawler for Telegram-owned sites, HTML links, static asset URLs, and manually supplied seed pages.
- **Crawl safety:** host allowlist, `robots.txt` support, same-host redirect policy, response-size limits, per-host request pacing, and protection against replacing a healthy URL inventory with a dramatically smaller crawl.
- **Resource snapshots:** daily manifests for tracked HTML pages and static resources, with SHA-256 content-addressed storage that avoids duplicate bodies.
- **Conditional fetching:** ETag and Last-Modified validators reduce repeated downloads when the server supports them.
- **Collector safety:** robots.txt checks, same-host HTTPS redirects, per-file and total byte budgets, bounded concurrency, and round-robin coverage for large inventories.
- **Reference-inspired normalization:** conservative helpers for volatile values in Telegram production web resources.
- **Automation:** scheduled and manually triggerable MTProto workflow, with status visible in the dashboard.
- **Automatic releases:** GitHub creates a Release with the generated Markdown report whenever the MTProto schema actually changes.
- **Snapshot diff viewer:** compare any two saved MTProto snapshots and inspect added, removed, and modified declarations.
- **Telegram notifications:** optional messages for real MTProto schema changes, plus a manual notification test.
- **Tests:** Node's built-in test runner, with no extra test dependencies.
- **Web dashboard:** GitHub Pages provides searchable declarations, snapshot history, workflow status, and an interactive diff.

## Requirements

- Node.js 22 or newer.
- Git for the scheduled workflow's generated snapshot commits.
- No npm install step is required for runtime or tests.

## Quick start

    node src/index.js update
    node src/index.js check
    node src/index.js crawl --max-pages 500 --max-depth 2
    node src/index.js collect --max-resources 1000 --max-total-mb 64
    npm test

The first `update` creates an MTProto baseline. Since no earlier snapshot exists yet, it cannot report historical changes on that first run. Subsequent runs compare against that baseline.

The `crawl` command writes `tracked_links.txt`, `tracked_res_links.txt`, and `crawler-report.json`. The `collect` command reads both URL inventories, downloads and normalizes content, and writes dated manifests and reports. It stores each normalized response body once under `resource_objects/` using its SHA-256 digest.

## CLI

| Command | Behaviour |
| --- | --- |
| `node src/index.js update` | Fetch the schema, compare it to the latest snapshot, and save a dated snapshot and report for each successful check. |
| `node src/index.js check` | Check for schema changes without writing; exits with status 1 when changes are detected and 2 when no baseline exists. |
| `node src/index.js crawl` | Discover Telegram-owned pages and static-resource URLs, then save the URL inventories. |
| `node src/index.js collect` | Download, normalize, hash, compare and archive tracked pages and resources. |

Options available for all commands:

- `--root PATH`: project data directory, default `. `.
- `--timeout SECONDS`: HTTP timeout, default `30` for MTProto and `20` for crawling.

Schema option:

- `--schema-url URL`: alternate MTProto schema endpoint, useful for testing.

Crawler options:

- `--max-pages N`: maximum HTML pages to fetch, from `1` to `5000`, default `500`.
- `--max-depth N`: link depth, from `0` to `10`, default `2`.
- `--concurrency N`: parallel requests, from `1` to `20`, default `5`.
- `--delay-ms N`: minimum delay between requests to the same host, from `0` to `5000`, default `150`.
- `--seed URL`: add a seed URL. Repeat the option to provide multiple seeds. Supplying custom seeds replaces the built-in seed list.

Resource collector options:

- `--max-resources N`: maximum URLs checked per run, default `1000`. The collector rotates its starting position between runs so later URLs are not starved.
- `--max-resource-mb N`: maximum download size for one non-page resource, default `4` MiB. HTML pages have a separate 2 MiB limit.
- `--max-total-mb N`: total response-body download budget per run, default `64` MiB.

## Repository layout

    .github/workflows/    GitHub Actions automation
    src/core.js           MTProto fetching, validation, diff, reports and storage
    src/crawler.js        Telegram page and resource URL discovery
    src/resource-collector.js  Safe resource fetching, normalization and archival
    src/normalize.js      Volatile resource normalization
    src/index.js          CLI entry point
    site/app.js           Browser dashboard controller
    site/index.html       Dashboard structure and styles
    tests/                Node built-in tests
    snapshots/            Dated MTProto snapshots and latest baseline
    reports/              Dated MTProto reports and latest report
    tracked_links.txt     Discovered Telegram page URLs (host + path)
    tracked_res_links.txt Discovered Telegram resource URLs (host + path)
    crawler-report.json  Last crawl summary and failures
    resource_snapshots/  Dated resource manifests and latest baseline
    resource_reports/    Dated resource change reports
    resource_objects/    Content-addressed normalized response bodies

The MTProto tracker runs daily at 04:17 UTC and can also be started from **Actions → Track Telegram MTProto schema → Run workflow**.

## Resource crawler scope

The crawler starts from a small set of Telegram-owned sites and follows HTML links up to the configured depth. It only accepts `telegram.org` and `contest.com` hosts (including their subdomains), respects `robots.txt`, limits response sizes, and rejects cross-host redirects. The collector then reads both discovered page and resource inventories. It checks robots.txt again, follows only same-host HTTPS redirects, applies ETag/Last-Modified validators, enforces per-file and total download budgets, and normalizes text/JSON responses before hashing them. Binary files are archived byte-for-byte. HTTP 404/410 responses are recorded as removals; network errors and robots blocks preserve the previous known-good hash instead of being treated as deletions.

Normalized bodies are stored once at `resource_objects/<first-two-hash-characters>/<sha256>`. Dated manifests in `resource_snapshots/` map URLs to hashes and object paths; Markdown summaries are written to `resource_reports/`. When the inventory exceeds `--max-resources`, collection rotates through the list on later runs. Failed or deferred URLs remain eligible for a future run.

The crawler is inspired by the documented goals of [prodserverchangesall](https://github.com/glebxdlolreal/prodserverchangesall) and the public architecture described by [Telegram Crawler](https://github.com/MarshalX/telegram-crawler). This project does not copy their source code or snapshot assets.

## Optional Telegram notifications

1. Create a bot with Telegram's official [@BotFather](https://t.me/BotFather), then open the bot and press **Start**.
2. Add repository Actions secrets under **Settings → Secrets and variables → Actions**:
   - `TELEGRAM_BOT_TOKEN`: the bot token from BotFather.
   - `TELEGRAM_CHAT_ID`: the chat ID that should receive notifications.
3. To send a test message regardless of whether the schema changed, open **Actions → Test Telegram notification → Run workflow**.
4. The regular tracker sends notifications when schema changes are detected. It can also send a test message when its `test_notification` input is enabled.

Never commit the token or paste it into issues or chat. Notifications are optional; schema tracking works without them.

## Web dashboard

The static dashboard lives in `site/` and is deployed through GitHub Pages. It loads public snapshots and reports from this repository and reads the latest tracker run from GitHub's public Actions API. Use **Snapshot history** to open an archived snapshot, or **Compare snapshots** to inspect declaration additions, removals, and modifications between two dates. No server, API key, or client-side token is required.

A repository owner must enable Pages once: open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. Then run **Actions → Deploy dashboard to GitHub Pages → Run workflow**.

## How MTProto change detection works

The JSON is canonicalized before comparison: declaration collections are sorted by stable names and object keys are serialized consistently. Each constructor, method, or type is identified by its schema name. Reports list additions, removals, modifications, and meaningful metadata changes.

The resource normalizer removes only known volatile fragments rather than filtering content merely because it changes often. The source of truth for MTProto tracking is Telegram's own schema endpoint. This project is an independent community tool and is not affiliated with Telegram.

See [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).
