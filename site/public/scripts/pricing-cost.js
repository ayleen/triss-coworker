// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

(function () {
'use strict';
const DATA = JSON.parse(document.getElementById('pricing-data').textContent);
const profile = DATA.profile;
const anthropic = DATA.anthropic;
const deepseek = DATA.deepseek;
const defaults = DATA.defaults;
const IN_TOK = profile.inK, OUT_TOK = profile.outK, SUM_IN = profile.sumInK, SUM_OUT = profile.sumOutK;
const PRIMARY = { mid: anthropic.sonnet, top: anthropic.opus };
const DEEPSEEK = deepseek;
let s = { reqs: defaults.reqs, share: defaults.share, primary: "mid", providerModel: defaults.providerModel, cacheHit: defaults.cacheHit };
function money(v) {
  if (v >= 1000) return "$" + Math.round(v).toLocaleString("en-US");
  if (v >= 100) return "$" + v.toFixed(0);
  return "$" + v.toFixed(2);
}
function delegatedPer(modelClass, hit) {
  const d = DEEPSEEK[modelClass];
  const inputCost = IN_TOK * (1 - hit/100) * d.input / 1000;
  const cacheCost = IN_TOK * (hit/100) * d.cache / 1000;
  const outCost = OUT_TOK * d.output / 1000;
  return inputCost + cacheCost + outCost;
}
function render() {
  const p = PRIMARY[s.primary];
  const delegatedCost = delegatedPer(s.providerModel, s.cacheHit);
  const primaryPer = (IN_TOK * p.input + OUT_TOK * p.output) / 1000;
  const summaryPer = (SUM_IN * p.input + SUM_OUT * p.output) / 1000;
  const monthly = s.reqs * 30;
  const delegated = monthly * (s.share / 100);
  const kept = monthly - delegated;
  const without = monthly * primaryPer;
  const withT = kept * primaryPer + delegated * (delegatedCost + summaryPer);
  const saved = without - withT;
  document.getElementById("c-reqs").textContent = String(s.reqs);
  document.getElementById("c-share").textContent = s.share + "%";
  document.getElementById("c-without").textContent = money(without);
  document.getElementById("c-with").textContent = money(withT);
  document.getElementById("c-saved").textContent = "saves " + money(saved) + " / month \u00b7 " + Math.round((saved/without)*100) + "% less";
  document.getElementById("c-annual").textContent = money(saved*12);
  const bd = document.getElementById("c-breakdown");
  if (bd) {
    const d = DEEPSEEK[s.providerModel];
    const inUncached = (IN_TOK * (1 - s.cacheHit/100) * d.input / 1000).toFixed(4);
    const inCache = (IN_TOK * (s.cacheHit/100) * d.cache / 1000).toFixed(5);
    const row = (label, value, opts = {}) => {
      const div = document.createElement("div");
      div.style.display = "flex";
      div.style.justifyContent = "space-between";
      if (opts.indent) div.style.paddingLeft = "12px";
      const l = document.createElement("span");
      l.style.color = opts.indent ? "var(--color-text-label)" : "var(--color-text-muted)";
      if (opts.indent) l.style.fontSize = "11.5px";
      l.textContent = label;
      const v = document.createElement("span");
      v.style.fontFamily = "var(--font-mono)";
      if (opts.indent) v.style.fontSize = "11.5px";
      v.textContent = value;
      div.append(l, v);
      return div;
    };
    const rows = [
      row("Requests / month", monthly.toLocaleString("en-US")),
      row("Kept on primary", Math.round(kept).toLocaleString("en-US") + " \u00b7 " + money(kept * primaryPer)),
      row("Run by provider", Math.round(delegated).toLocaleString("en-US") + " \u00b7 " + money(delegated * delegatedCost)),
      row("\u21b3 input " + (100 - s.cacheHit) + "% @ $" + d.input + " + cache " + s.cacheHit + "% @ $" + d.cache,
        "$" + inUncached + " + $" + inCache, { indent: true }),
      row("Summaries read back", money(delegated * summaryPer)),
    ];
    bd.replaceChildren(...rows);
  }
  document.getElementById("c-mid").style.borderColor = s.primary === "mid" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-mid").style.color = s.primary === "mid" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-mid").setAttribute("aria-pressed", String(s.primary === "mid"));
  document.getElementById("c-top").style.borderColor = s.primary === "top" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-top").style.color = s.primary === "top" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-top").setAttribute("aria-pressed", String(s.primary === "top"));
  document.getElementById("c-standard").style.borderColor = s.providerModel === "standard" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-standard").style.color = s.providerModel === "standard" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-standard").setAttribute("aria-pressed", String(s.providerModel === "standard"));
  document.getElementById("c-advanced").style.borderColor = s.providerModel === "advanced" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-advanced").style.color = s.providerModel === "advanced" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-advanced").setAttribute("aria-pressed", String(s.providerModel === "advanced"));
}
document.getElementById("c-reqs-slider").addEventListener("input", e => { s.reqs = parseInt(e.target.value,10); render(); });
document.getElementById("c-share-slider").addEventListener("input", e => { s.share = parseInt(e.target.value,10); render(); });
const cacheSlider = document.getElementById("c-cache-slider");
if (cacheSlider) cacheSlider.addEventListener("input", e => { s.cacheHit = parseInt(e.target.value,10); const el = document.getElementById("c-cache"); if (el) el.textContent = s.cacheHit + "%"; render(); });
document.getElementById("c-mid").addEventListener("click", () => { s.primary = "mid"; render(); });
document.getElementById("c-top").addEventListener("click", () => { s.primary = "top"; render(); });
document.getElementById("c-standard").addEventListener("click", () => { s.providerModel = "standard"; render(); });
document.getElementById("c-advanced").addEventListener("click", () => { s.providerModel = "advanced"; render(); });

render();
})();
