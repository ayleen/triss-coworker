// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

(function () {
'use strict';
const DATA = JSON.parse(document.getElementById('pricing-data').textContent);
const PROFILE = DATA.profile;
const ANTHROPIC = DATA.anthropic;
const DEEPSEEK = DATA.deepseek;
const defaults = DATA.defaults;
function primaryPer(m) { const p = ANTHROPIC[m]; return (PROFILE.inK * p.input + PROFILE.outK * p.output) / 1000; }
function summaryPer(m) { const p = ANTHROPIC[m]; return (PROFILE.sumInK * p.input + PROFILE.sumOutK * p.output) / 1000; }
function delegatedPer(hit) { const d = DEEPSEEK[defaults.providerModel]; return (PROFILE.inK * (1-hit/100) * d.input + PROFILE.inK * (hit/100) * d.cache + PROFILE.outK * d.output) / 1000; }
function trissPer(m, hit) { return delegatedPer(hit) + summaryPer(m); }
const DEFAULT_HIT = defaults.cacheHit;
function money(v) {
  if (v >= 100) return "$" + Math.round(v).toLocaleString("en-US");
  return "$" + v.toFixed(2);
}
let state = { reqs: defaults.reqs, share: defaults.share, model: defaults.primary };
const els = {
  reqs: document.getElementById("reqs-display"),
  share: document.getElementById("share-display"),
  without: document.getElementById("cost-without"),
  with: document.getElementById("cost-with"),
  saved: document.getElementById("saved-line"),
  sonnet: document.getElementById("btn-sonnet"),
  opus: document.getElementById("btn-opus"),
  reqsSlider: document.getElementById("reqs-slider"),
  shareSlider: document.getElementById("share-slider"),
};
function render() {
  const monthly = state.reqs * 30;
  const per = primaryPer(state.model);
  const without = monthly * per;
  const withT = monthly * (1 - state.share / 100) * per + monthly * (state.share / 100) * trissPer(state.model, DEFAULT_HIT);
  const saved = without - withT;
  if (els.reqs) els.reqs.textContent = String(state.reqs);
  if (els.share) els.share.textContent = state.share + "%";
  if (els.without) els.without.textContent = money(without);
  if (els.with) els.with.textContent = money(withT);
  if (els.saved) els.saved.textContent = "saves " + money(saved) + " / month \u00b7 " + Math.round((saved / without) * 100) + "% less";
  if (els.sonnet && els.opus) {
    const on = state.model === "sonnet";
    els.sonnet.style.background = on ? "var(--color-accent)" : "transparent";
    els.sonnet.style.color = on ? "#0b0d10" : "var(--color-text-muted)";
    els.sonnet.style.borderColor = on ? "var(--color-accent)" : "var(--color-border-strong)";
    els.sonnet.setAttribute("aria-pressed", String(on));
    els.opus.setAttribute("aria-pressed", String(!on));
    els.opus.style.background = !on ? "var(--color-accent)" : "transparent";
    els.opus.style.color = !on ? "#0b0d10" : "var(--color-text-muted)";
    els.opus.style.borderColor = !on ? "var(--color-accent)" : "var(--color-border-strong)";
  }
}
if (els.reqsSlider) els.reqsSlider.addEventListener("input", (e) => { state.reqs = parseInt(e.target.value, 10); render(); });
if (els.shareSlider) els.shareSlider.addEventListener("input", (e) => { state.share = parseInt(e.target.value, 10); render(); });
if (els.sonnet) els.sonnet.addEventListener("click", () => { state.model = "sonnet"; render(); });
if (els.opus) els.opus.addEventListener("click", () => { state.model = "opus"; render(); });
const copyBtn = document.getElementById("copy-install-btn");
const copyLabel = document.getElementById("copy-label");
if (copyBtn) copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText("npm install -g triss-coworker").then(() => {
    if (copyLabel) copyLabel.textContent = "copied";
    setTimeout(() => { if (copyLabel) copyLabel.textContent = "copy"; }, 1500);
  });
});
render();

const CMDS = [
  { name: "ask", tier: "small", short: "Reads files, URLs, or stdin — returns a focused summary.", note: "The whole trick: the primary agent gets the useful bits, not a firehose.", lines: "$ triss ask --provider zai --model glm-5.2 \\\n    --paths \"src/**/*.ts\" \\\n    --question \"where do we read the API key?\"\n\n→ 47 files read · 18.3K in / 2.4K out\n→ src/config.js, src/mcp/server.js\ncost: $0.0056 (off-peak, $0.011 peak)" },
  { name: "review", tier: "main", short: "Code review on a branch, a PR, or a piped diff.", note: "Concrete issues with file:line citations — not a diff summary.", lines: "$ triss review 123 --provider moonshot --model kimi-k3\n\nFindings\n- src/auth.js:42 accepts an expired token\n- test/auth.test.js:88 covers only happy path\nResidual risk: refresh path untested" },
  { name: "write", tier: "main", short: "Generates code or docs from a spec plus a reference file.", note: "Boilerplate the primary model should never type.", lines: "$ triss write --spec \"pytest for auth.py\" \\\n    --context tests/test_main.py \\\n    --target tests/test_auth.py\n\n→ wrote tests/test_auth.py (128 lines)" },
  { name: "fetch", tier: "small", short: "Fetches URLs and returns clean markdown.", note: "SSRF-guarded, 30s timeout, strips chrome.", lines: "$ triss fetch https://api-docs.example.com/ \\\n    --question \"auth header format?\"\n\n→ 214KB HTML → 3.1K markdown\n→ Bearer <token>, no refresh" },
  { name: "coder", tier: "agent", short: "Delegates an implementation task to a coding agent.", note: "--isolate runs in a disposable git worktree.", lines: "$ triss coder run \"add /signup validation\" \\\n    --engine omp --provider opencode-go --isolate\n\n→ 3 files changed in .triss/wt/signup" },
];
let cmdIdx = 0;
const cmdList = document.getElementById("cmd-list");
const cmdTitle = document.getElementById("cmd-title");
const cmdNote = document.getElementById("cmd-note");
const cmdCode = document.getElementById("cmd-code");
function renderCmd() {
  if (!cmdList) return;
  cmdList.innerHTML = "";
  CMDS.forEach((c, i) => {
    const b = document.createElement("button");
    b.textContent = "triss " + c.name + "  · " + c.tier;
    b.style.cssText = "text-align:left; padding:12px 16px; font-family:var(--font-mono); font-size:12.5px; cursor:pointer; border:none; border-bottom:1px solid var(--color-border-subtle); background:" + (i===cmdIdx ? "#151920" : "var(--color-bg-raised)") + "; color:" + (i===cmdIdx ? "var(--color-accent)" : "var(--color-text-code)");
    b.setAttribute("aria-pressed", String(i===cmdIdx));
    b.addEventListener("click", () => { cmdIdx = i; renderCmd(); });
    cmdList.appendChild(b);
  });
  const a = CMDS[cmdIdx];
  if (cmdTitle) cmdTitle.textContent = "triss " + a.name + " — " + a.short;
  if (cmdNote) cmdNote.textContent = a.note;
  if (cmdCode) cmdCode.textContent = a.lines;
}
renderCmd();

const TABS = {
  npm: "$ npm install -g triss-coworker\n\n$ triss config wizard\n  Default provider [zai]\n  Native model [glm-5.2]\n✓ provider profile saved · MCP + rules installed",
  curl: "$ curl -fsSL https://raw.githubusercontent.com/\\n    ayleen/triss-coworker/main/install.sh | bash\n\n→ ~/.local/share/triss (receipt-backed)\n→ linked ~/.local/bin/triss",
  source: "$ git clone https://github.com/ayleen/triss-coworker.git\n$ cd triss-coworker && npm install && npm link\n\n$ triss --version && triss status\n✓ default provider: zai · model: glm-5.2",
};
let tab = "npm";
const installCode = document.getElementById("install-code");
function renderTab() {
  if (installCode) installCode.textContent = TABS[tab];
  document.querySelectorAll(".tab-btn").forEach((b) => {
    const on = b.getAttribute("data-tab") === tab;
    b.style.background = on ? "#08090b" : "var(--color-bg-raised)";
    b.style.color = on ? "var(--color-accent)" : "var(--color-text-muted)";
    b.setAttribute("aria-pressed", String(on));
  });
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => { tab = b.getAttribute("data-tab"); renderTab(); }));
renderTab();
})();
