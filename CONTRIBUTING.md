# Contributing

Thanks for helping improve Telegram API Diff.

## Development setup

Use Node.js 22 or newer. No third-party packages are needed.

## Before opening a pull request

Run the project's test suite:

    npm test

Also check the CLI and dashboard JavaScript syntax:

    node --check src/index.js
    node --check site/app.js

Please include tests for new schema comparison, normalization, or reporting behaviour. Keep the runtime dependency-free unless a new dependency provides a clear benefit.

## Schema source

The default source is Telegram's official machine-readable schema at https://core.telegram.org/schema/json. Do not replace it with an unofficial mirror without documenting the trade-off and adding tests.

## Reporting a problem

Open a GitHub issue with the command you ran, the expected behaviour, the actual behaviour, and a minimal reproducible example. Remove any personal tokens or sensitive data before posting.
