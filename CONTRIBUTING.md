# Contributing

Thanks for helping improve Telegram API Diff.

## Development setup

Use Python 3.11 or newer. Create a virtual environment, activate it, and install the development dependencies with:

    python -m venv .venv
    source .venv/bin/activate
    python -m pip install -e ".[dev]"

## Before opening a pull request

Run the project's quality checks:

    ruff check src tests
    pytest
    python -m compileall -q src

Please include tests for new comparison or reporting behaviour. Keep the runtime dependency-free unless a new dependency provides a clear benefit.

## Schema source

The default source is Telegram's official machine-readable schema at https://core.telegram.org/schema/json. Do not replace it with an unofficial mirror without documenting the trade-off and adding tests.

## Reporting a problem

Open a GitHub issue with the command you ran, the expected behaviour, the actual behaviour, and a minimal reproducible example. Remove any personal tokens or sensitive data before posting.
