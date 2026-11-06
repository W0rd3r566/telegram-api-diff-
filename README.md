# Telegram API Diff

Track changes in Telegram's official MTProto TL schema with a dependency-free Node.js engine and a JavaScript dashboard.

Telegram API Diff downloads Telegram's machine-readable schema, compares it with previous snapshots, stores versioned JSON data, and writes Markdown reports. The runner uses Node's built-in Fetch API and filesystem modules. No npm runtime dependencies are required.

If this project is useful to you, please **⭐ star this repository**. It helps other developers discover it and motivates further development.  
Если проект оказался полезным, пожалуйста, **⭐ поставьте звезду этому репозиторию**. Так другим разработчикам будет проще его найти, а у проекта будет больше мотивации для развития.

## Features

- **Official source:** [Telegram's machine-readable TL schema](https://core.telegram.org/schema/json), with the current API layer read from [Telegram's schema documentation](https://core.telegram.org/schema).
- **Structured change detection:** added, removed, and modified declarations, plus changes to the API layer and other top-level metadata.
- **Snapshot history:** dated JSON snapshots in `snapshots/`, with `snapshots/latest.json` as the current baseline.
- **Detailed Markdown reports:** dated reports in `reports/` and `reports/latest.md`, including field and parameter-level changes.
- **Reference-inspired normalization:** conservative helpers for volatile values in Telegram production web resources.
- **Automation:** scheduled and manually triggerable GitHub Actions workflow, with status visible in the dashboard.
- **Automatic releases:** GitHub creates a Release with the generated Markdown report whenever the schema actually changes.
- **Snapshot diff viewer:** compare any two saved snapshots and inspect added, removed, and modified declarations.
- **Weekly monitor:** dashboard shows the latest tracker run and changes recorded in recent reports.
- **Telegram notifications:** optional messages for real schema changes, plus a manual notification test.
- **Tests:** Node's built-in test runner, with no extra test dependencies.
- **Web dashboard:** GitHub Pages provides searchable declarations, snapshot history, workflow status, and an interactive diff.

## Requirements

- Node.js 22 or newer.
- Git for the scheduled workflow's generated snapshot commits.
- No npm install step is required for runtime or tests.

## Quick start

    node src/index.js update
    node src/index.js check
    npm test

The first `update` creates a baseline. Since no earlier snapshot exists yet, it cannot report historical changes on that first run. Subsequent runs compare against that baseline.

## CLI

| Command | Behaviour |
| --- | --- |
| `node src/index.js update` | Fetch the schema, compare it to the latest snapshot, and save a dated snapshot and report for each successful check. |
| `node src/index.js check` | Check for changes without writing; exits with status 1 when changes are detected and 2 when no baseline exists. |

Options available for both commands:

- `~`--root PATH``: project data directory, default `.`.
- `~`--schema-url URL``: alternate schema endpoint, useful for testing.
- `~`--timeout SECONDS``: HTTP timeout, default `30`.

## Repository layout

    .github/workflows/    GitHub Actions automation
    src/core.js           Fetching, validation, diff, reports and storage
    src/normalize.js      Volatile resource normalization
    src/index.js          CLI entry point
    site/app.js           Browser dashboard controller
    site/index.html       Dashboard structure and styles
    tests/                Node built-in tests
    snapshots/            Dated snapshots and latest baseline
    reports/              Dated reports and latest report

The tracker runs daily at 04:17 UTC and can also be started from **Actions → Track Telegram MTProto schema → Run workflow**.

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

## How change detection works

The JSON is canonicalized before comparison: declaration collections are sorted by stable names and object keys are serialized consistently. Each constructor, method, or type is identified by its schema name. Reports list additions, removals, modifications, and meaningful metadata changes.

The reference-inspired normalization helper uses documented behavior from [prodserverchangesall](https://github.com/glebxdlolreal/prodserverchangesall). It normalizes only known volatile fragments, rather than filtering content merely because it changes often. The reference repository's source files and snapshot assets are not copied.

## Data and attribution

The source of truth is Telegram's own schema endpoint. Snapshots and reports are automatically generated from that public data. This project is an independent community tool and is not affiliated with Telegram.

See [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).
