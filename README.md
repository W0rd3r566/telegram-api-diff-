# Telegram API Diff

Track changes in Telegram's official MTProto TL schema over time.

Telegram API Diff downloads the machine-readable schema published by Telegram, compares it with the previous snapshot, saves versioned JSON snapshots, and writes human-readable Markdown reports. GitHub Actions can run it daily without a server or API key.

If this project is useful to you, please **⭐ star this repository**. It helps other developers discover it and motivates further development.  
Если проект оказался полезным, пожалуйста, **⭐ поставьте звезду этому репозиторию**. Так другим разработчикам будет проще его найти, а у проекта будет больше мотивации для развития.

## Features

- **Official source:** [Telegram's machine-readable TL schema](https://core.telegram.org/schema/json), with [schema documentation](https://core.telegram.org/schema).
- **Structured change detection:** added, removed, and modified declarations, plus the current API layer from Telegram's official schema page.
- **Snapshot history:** dated JSON snapshots in `snapshots/`, with `snapshots/latest.json` as the current baseline.
- **Detailed Markdown reports:** dated reports in `reports/` and a convenient `reports/latest.md`, including field and parameter-level changes.
- **Automation:** scheduled and manually triggerable GitHub Actions workflow. Optional Telegram notifications are sent only when changes are detected.
- **No runtime dependencies:** the application uses Python's standard library.
- **Tests and linting:** pytest and Ruff run in CI.
- **Web dashboard:** a GitHub Pages dashboard with the latest layer, searchable declarations, and snapshot history.

## Quick start

Requires Python 3.11 or newer.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"

# Create the first snapshot, or compare and save any changes.
telegram-api-diff update

# Check the official schema without writing files.
telegram-api-diff check
```

On Windows, activate the environment with `.venv\Scripts\activate` instead.

The first `update` creates a baseline. Since no earlier snapshot exists yet, it cannot report historical changes on that first run. Subsequent runs compare against that baseline.

## CLI

| Command | Behaviour |
| --- | --- |
| `telegram-api-diff update` | Fetch the schema, compare it to the latest snapshot, and save a dated snapshot and report for each successful check. |
| `telegram-api-diff check` | Check for changes without writing; exits with status 1 when changes are detected and 2 when no baseline exists. |

Options available for both commands:

- `--root PATH`: project data directory, default `.`.
- `--schema-url URL`: alternate schema endpoint, useful for testing.
- `--timeout SECONDS`: HTTP timeout, default `30`.

You can also run the module directly with `python -m telegram_api_diff`.

## Repository layout

```text
.github/
  workflows/
    track-schema.yml    # Daily/manual schema tracker
    test-telegram.yml   # Manual Telegram notification test
    tests.yml           # Test and lint checks
src/
  telegram_api_diff/
    cli.py              # Command-line interface
    schema.py           # Fetching and canonicalization
    diff.py             # Structured comparison
    report.py           # Markdown reports
tests/
snapshots/              # Dated JSON snapshots and latest baseline
reports/                # Dated reports and latest report
```

The `snapshots/` and `reports/` data files are created when the tracker first runs. The tracker runs daily at 04:17 UTC and can also be started from **Actions → Track Telegram MTProto schema → Run workflow**.

## Optional Telegram notifications

1. Create a bot with Telegram's official [@BotFather](https://t.me/BotFather), then open the bot and press **Start**.
2. Add repository Actions secrets under **Settings → Secrets and variables → Actions**:
   - `TELEGRAM_BOT_TOKEN`: the bot token from BotFather.
   - `TELEGRAM_CHAT_ID`: the chat ID that should receive notifications.
3. To send a test message regardless of whether the schema changed, open **Actions → Test Telegram notification → Run workflow**. This separate workflow does not require selecting a checkbox.
4. The regular tracker sends notifications when schema changes are detected. It can also send a test message when its `test_notification` input is enabled.

Never commit the token or paste it into issues or chat. Notifications are optional; schema tracking works without them.

## Web dashboard

The static dashboard lives in `site/` and is deployed through GitHub Pages. A repository owner must enable it once: open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. The workflow token cannot change this repository setting automatically. Then run **Actions → Deploy dashboard to GitHub Pages → Run workflow**. The dashboard reads public snapshots from this repository and requires no server or API key.

## How change detection works

The JSON is canonicalized before comparison: declaration collections are sorted by stable names and object keys are serialized consistently. Each constructor, method, or type is identified by its schema name. The report lists new, removed, and modified declarations and highlights changes to the API layer or other top-level metadata.

A missing or malformed response is treated as an error rather than a valid empty schema, preventing accidental replacement of the baseline with an error page.

## Data and attribution

The source of truth is Telegram's own schema endpoint. Snapshots and reports are automatically generated from that public data. This project is an independent community tool and is not affiliated with Telegram.

See [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).
