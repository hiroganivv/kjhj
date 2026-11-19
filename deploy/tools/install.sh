#!/usr/bin/env bash
# Entry point for the host-tool installer (called from GitHub Actions).
# Runs with sudo available on ubuntu-latest. All recipes come from the Pojun
# hosttools catalog (deploy/tools/tool-catalog.json) - no hand-written apt/pip.
set -uo pipefail
cd "$(dirname "$0")"
python3 install.py
