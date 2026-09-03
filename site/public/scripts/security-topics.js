// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

(function () {
'use strict';
const TOPICS = {
  filesystem: { title: "Path sandbox in MCP mode", body: "The CLI reads the paths you pass it. In MCP mode file access is sandboxed to the project root by default.", vars: ["TRISS_RESTRICT_PATHS=1 — Default. MCP file access confined to TRISS_PROJECT_ROOT", "TRISS_PROJECT_ROOT — Baked into launcher entry for project-local installs"] },
  network: { title: "SSRF guard on agent-controlled fetches", body: "triss fetch and ask --urls block private, loopback, link-local, and metadata addresses by default. Responses are size-capped; HTML is stripped of scripts/styles.", vars: ["TRISS_ALLOW_PRIVATE_NETWORKS=1 — Only when you intentionally want internal docs", "--timeout <ms> — 30s default"] },
  credentials: { title: "Three config sources, real env always wins", body: "process.env → ./.triss.env → ~/.config/triss/.env . Wizard writes .triss.env with 600 and gitignores it. triss status masks secrets.", vars: ["process.env — highest precedence", "<project>/.triss.env — per-project, chmod 600", "~/.config/triss/.env — global defaults"] },
  coder: { title: "Worktree isolation is not a host sandbox", body: "Crush and OMP default to disposable Git worktrees, which limit repository mutations but do not block absolute-path or same-UID access. OMP ignores the user profile by using run-private config. Its default best_effort_raw mode forwards one selected key; protected mode forwards only a short-lived proxy token and denies bash.", vars: ["triss coder run --engine omp --protect-credentials", "PI_CODING_AGENT_DIR — run-private, removed after the run", ".triss/omp/sessions — Triss-owned native session storage"] },
  log: { title: "Metadata only, and deletable", body: "Every provider call appends one record: timestamp, provider, model, token counts, cost, label, call id, cwd. Prompt and file content are never written.", vars: ["TRISS_USAGE_LOG_CWD=0 — keep log but stop recording cwd", "TRISS_USAGE_LOG=0 — no log", "triss usage --reset — delete log"] },
  updates: { title: "One credential-free GET, integrity-checked apply", body: "Passive update discovery is the only automatic network path. Applying an update is explicit and only for receipt-backed standalone installs.", vars: ["TRISS_UPDATE_CHECK=0 — disables passive checks", "triss update --apply — standalone installs only"] },
  supply: { title: "Signed tags, provenance, and CI gates", body: "Release tags are GPG-signed and the publish pipeline rejects unsigned or unknown-key tags before anything is published. npm packages carry Sigstore provenance attestations, and every PR runs CodeQL, secret scanning, dependency review, and enforced test coverage.", vars: ["git tag -s — signature verified fail-closed in CI", "npm publish --provenance — Sigstore attestations", "CodeQL + gitleaks + Dependabot + c8 coverage on every PR"] },
};
let topic = "filesystem";
function renderTopic() {
  const t = TOPICS[topic];
  document.getElementById("topic-panel").innerHTML = "<div style='font-size:17px; font-weight:600; color:var(--color-text-heading);'>" + t.title + "</div><p style='margin:10px 0 0; font-size:13.5px; line-height:1.6; color:var(--color-text-secondary);'>" + t.body + "</p><div style='margin-top:16px; display:flex; flex-direction:column; gap:6px;'>" + t.vars.map(v => "<span style='font-family:var(--font-mono); font-size:12px; background:var(--color-bg-code); border:1px solid var(--color-border-subtle); padding:6px 10px; color:var(--color-text-muted);'>" + v + "</span>").join("") + "</div>";
  document.querySelectorAll(".topic-btn").forEach(b => {
    const on = b.getAttribute("data-topic")===topic;
    b.style.background = on ? "var(--color-bg-raised)" : "transparent";
    b.style.color = on ? "var(--color-accent)" : "var(--color-text-muted)";
    b.style.borderColor = on ? "var(--color-border-strong)" : "var(--color-border-strong)";
  });
}
document.querySelectorAll(".topic-btn").forEach(b => b.addEventListener("click", () => { topic = b.getAttribute("data-topic"); renderTopic(); }));
renderTopic();
})();
