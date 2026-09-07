// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Fault injection for the real run-agent-http.mjs source (review finding F2).
// Wrangler is never started: a temporary fake npx serves loopback readiness,
// and a temporary acceptance child exercises success/failure/signal exits.
// Nothing in the repository is modified. POSIX only — signal cases are
// skipped on Windows (CI runs them on Ubuntu).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "..", "scripts", "run-agent-http.mjs");

// [name, acceptance-child program, runner must succeed]
const cases = [
  ["normal success", "process.exit(0);", true],
  ["normal test failure", "process.exit(7);", false],
  ["SIGTERM during tests", 'process.kill(process.pid,"SIGTERM");', false],
  ["SIGKILL during tests", 'process.kill(process.pid,"SIGKILL");', false],
];

for (const [name, program, shouldSucceed] of cases) {
  test(`agent-http runner: ${name}`, { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-http-runner-"));
    const scripts = path.join(temp, "site", "scripts");
    let proc;
    let timer;
    try {
      await fs.mkdir(scripts, { recursive: true });
      await fs.mkdir(path.join(temp, "site", "dist"), { recursive: true });
      await fs.mkdir(path.join(temp, "bin"), { recursive: true });
      await fs.writeFile(path.join(temp, "site", "dist", "index.html"), "<h1>runner harness</h1>");
      await fs.copyFile(runner, path.join(scripts, "run-agent-http.mjs"));
      await fs.writeFile(path.join(scripts, "check-agent-http.mjs"), `${program}\n`);
      const fakeNpx = path.join(temp, "bin", "npx");
      await fs.writeFile(
        fakeNpx,
        "#!/usr/bin/env node\n" +
          'const fs=require("node:fs"),http=require("node:http");\n' +
          'fs.writeFileSync("fake-worker.pid",String(process.pid));\n' +
          'const i=process.argv.indexOf("--port");\n' +
          'http.createServer((q,s)=>s.end("ready")).listen(Number(process.argv[i+1]),"127.0.0.1");\n',
      );
      await fs.chmod(fakeNpx, 0o755);

      let output = "";
      proc = spawn(process.execPath, [path.join(scripts, "run-agent-http.mjs")], {
        cwd: temp,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: path.join(temp, "bin") + path.delimiter + process.env.PATH },
      });
      proc.stdout.on("data", (chunk) => {
        output += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const outcome = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("harness deadline exceeded"));
        }, 15_000);
        proc.once("error", reject);
        proc.once("close", (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(timer);
      t.diagnostic(output.trim());
      assert.equal(outcome.signal, null, "the runner itself must exit normally");
      if (shouldSucceed) assert.equal(outcome.code, 0);
      else assert.notEqual(outcome.code, 0, `child failed, but the runner exited with zero:\n${output}`);
    } finally {
      clearTimeout(timer);
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      // Emergency cleanup of the fake detached worker, independent of the runner.
      try {
        const pid = Number(await fs.readFile(path.join(temp, "site", "fake-worker.pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 1) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* no pid file */
      }
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
}

test("agent-http runner: unusable npx fails the run", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-http-runner-"));
  const scripts = path.join(temp, "site", "scripts");
  let proc;
  let timer;
  try {
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(path.join(temp, "site", "dist"), { recursive: true });
    await fs.mkdir(path.join(temp, "empty-bin"), { recursive: true });
    await fs.writeFile(path.join(temp, "site", "dist", "index.html"), "<h1>runner harness</h1>");
    await fs.copyFile(runner, path.join(scripts, "run-agent-http.mjs"));
    await fs.writeFile(path.join(scripts, "check-agent-http.mjs"), "process.exit(0);\n");

    let output = "";
    // PATH without any npx: the spawn must error out and the runner must
    // exit nonzero instead of reporting success.
    proc = spawn(process.execPath, [path.join(scripts, "run-agent-http.mjs")], {
      cwd: temp,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: path.join(temp, "empty-bin") },
    });
    proc.stdout.on("data", (chunk) => {
      output += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const outcome = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("harness deadline exceeded"));
      }, 15_000);
      proc.once("error", reject);
      proc.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    t.diagnostic(output.trim());
    assert.notEqual(outcome.code, 0, "a spawn failure must fail the runner");
  } finally {
    clearTimeout(timer);
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await fs.rm(temp, { recursive: true, force: true });
  }
});
