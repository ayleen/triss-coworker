// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Cloudflare Workers entry for triss.work static assets. All request logic
// lives in router.js (pure, unit-tested with web-standard Request/Response);
// this file only wires it to the worker contract.

import { route } from "./router.js";

export default {
  async fetch(request, env) {
    return route(request, env);
  },
};
