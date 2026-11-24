#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 ayleen
set -euo pipefail

archive="${RUNNER_TEMP:?}/dsh-0.1.0-rc.6.tgz"
sha512='6eba597c40fb89e45ad8f439b54c4c847accd696f60a628554cfdfeb23142c10cc89c6a193e6763ac1e04f04c39e88999b6dc5b6ef6b433d0d378a5f95aa0972'
curl --fail --silent --show-error --retry 3 \
  'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.0-rc.6.tgz' --output "$archive"
printf '%s  %s\n' "$sha512" "$archive" | sha512sum --check
npm install --global "$archive"
dsh --version
