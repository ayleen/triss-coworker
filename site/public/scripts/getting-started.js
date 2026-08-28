// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

(function () {
'use strict';
let done = {};
let pm = "npm";
let agent = "claude";
const PM = {
  npm: "$ npm install -g triss-coworker\n\nadded 1 package in 2s\n$ triss --version\n0.37.2",
  pnpm: "$ pnpm add -g triss-coworker\n\n$ triss --version\n0.37.2",
  yarn: "$ yarn global add triss-coworker\n\n$ triss --version\n0.37.2",
  curl: "$ curl -fsSL https://raw.githubusercontent.com/\\n    ayleen/triss-coworker/main/install.sh | bash\n\n→ ~/.local/share/triss (receipt-backed)\n→ linked ~/.local/bin/triss",
};
const AGENT = {
  claude: { code: "$ triss mcp install --target claude\n✓ ~/.claude.json\n\n$ triss init --target claude    # rules fallback\n✓ ./CLAUDE.md  (~15 lines)", note: "Restart the session, then /mcp — triss appears with its per-tool list." },
  codex: { code: "$ triss mcp install --target codex\n✓ ~/.codex/config.toml  (always global)\n  startup_timeout_sec = 30\n\n$ triss init --target codex\n✓ ./AGENTS.md", note: "Restart the Codex CLI and verify with codex mcp list." },
  other: { code: "$ triss init --target both --global\n✓ ~/.claude/CLAUDE.md\n✓ ~/.codex/AGENTS.md\n\n$ triss agent-help    # full cookbook, on demand", note: "Any orchestrator that reads a rules file or speaks MCP can hire Triss." },
};
function renderProgress() {
  const c = Object.keys(done).filter(k => done[k]).length;
  document.getElementById("progress-bar").style.width = (c/5*100)+"%";
  document.getElementById("progress-label").textContent = c+" / 5 done";
}
function renderPm() {
  document.getElementById("pm-code").textContent = PM[pm];
  document.querySelectorAll(".pm-btn").forEach(b => {
    const on = b.getAttribute("data-pm")===pm;
    b.style.background = on ? "#08090b" : "var(--color-bg-raised)";
    b.style.color = on ? "var(--color-accent)" : "var(--color-text-muted)";
    b.setAttribute("aria-pressed", String(on));
  });
}
function renderAgent() {
  document.getElementById("agent-code").textContent = AGENT[agent].code;
  document.getElementById("agent-note").textContent = AGENT[agent].note;
  document.querySelectorAll(".agent-btn").forEach(b => {
    const on = b.getAttribute("data-agent")===agent;
    b.style.background = on ? "#08090b" : "var(--color-bg-raised)";
    b.style.color = on ? "var(--color-accent)" : "var(--color-text-muted)";
    b.setAttribute("aria-pressed", String(on));
  });
}
document.querySelectorAll(".done-btn").forEach(b => b.addEventListener("click", () => {
  const n = b.getAttribute("data-step");
  done[n] = !done[n];
  b.textContent = done[n] ? "✓ done" : "mark done";
  b.style.borderColor = done[n] ? "var(--color-accent)" : "var(--color-border-strong)";
  b.style.color = done[n] ? "var(--color-accent)" : "var(--color-text-faint)";
  renderProgress();
}));
document.querySelectorAll(".pm-btn").forEach(b => b.addEventListener("click", () => { pm = b.getAttribute("data-pm"); renderPm(); }));
document.querySelectorAll(".agent-btn").forEach(b => b.addEventListener("click", () => { agent = b.getAttribute("data-agent"); renderAgent(); }));
renderProgress(); renderPm(); renderAgent();
})();
