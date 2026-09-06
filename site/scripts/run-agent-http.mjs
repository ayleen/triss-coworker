// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Runs the HTTP acceptance matrix (check-agent-http.mjs) against a real
// local worker: builds nothing itself — it expects `npm run build` to have
// produced dist/ — starts `wrangler dev` on a free loopback port, waits
// with bounded polling, and always stops the process again, including on
// test failures. Uses the locally installed wrangler; no network access,
// no credentials, local mode only.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.join(here, "..");
const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

function log(message) {
  console.log(`[run-agent-http] ${message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(siteRoot, "dist", "index.html"))) {
    console.error("dist/ is missing — run `npm run build` first.");
    process.exit(2);
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logFile = path.join(siteRoot, ".wrangler", "agent-http-dev.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  log(`starting wrangler dev on ${base} (log: ${path.relative(siteRoot, logFile)})`);
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"],
    {
      cwd: siteRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const logStream = fs.createWriteStream(logFile);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  let stopped = false;
  // Negative PIDs address the detached process group; Windows has no process
  // groups, so fall back to the direct child handle there.
  const kill = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    kill("SIGTERM");
    const killTimer = setTimeout(() => kill("SIGKILL"), 3000);
    killTimer.unref();
    logStream.end();
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(143);
  });

  const dumpLog = () => {
    try {
      const lines = fs.readFileSync(logFile, "utf8").trimEnd().split("\n");
      console.error(`--- last ${Math.min(lines.length, 60)} wrangler log lines ---`);
      console.error(lines.slice(-60).join("\n"));
    } catch {
      /* no log output available */
    }
  };

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        dumpLog();
        throw new Error("wrangler dev exited before becoming ready.");
      }
      try {
        const response = await fetch(base);
        await response.arrayBuffer();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
    if (!ready) {
      dumpLog();
      throw new Error(`wrangler dev did not become ready within ${READY_TIMEOUT_MS}ms.`);
    }
    log("worker is up — running the HTTP acceptance matrix");

    const result = spawn(process.execPath, [path.join(here, "check-agent-http.mjs"), "--base", base], {
      cwd: siteRoot,
      stdio: "inherit",
    });
    // Success is ONLY a normal exit with code 0: a signal or a null code
    // (crash, external kill) means the suite did not complete and must fail
    // the run — otherwise CI could go green on an aborted acceptance child.
    const outcome = await new Promise((resolve, reject) => {
      result.once("error", reject);
      result.once("close", (code, signal) => resolve({ code, signal }));
    });
    const succeeded = outcome.code === 0 && outcome.signal == null;
    log(`acceptance suite finished: code=${outcome.code}, signal=${outcome.signal ?? "none"}`);
    process.exitCode = succeeded
      ? 0
      : Number.isInteger(outcome.code) && outcome.code > 0
        ? outcome.code
        : 1;
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
