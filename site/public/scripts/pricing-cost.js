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
let s = { reqs: defaults.reqs, share: defaults.share, primary: "mid", worker: defaults.worker, cacheHit: defaults.cacheHit };
function money(v) {
  if (v >= 1000) return "$" + Math.round(v).toLocaleString("en-US");
  if (v >= 100) return "$" + v.toFixed(0);
  return "$" + v.toFixed(2);
}
function workerPer(worker, hit) {
  const d = DEEPSEEK[worker];
  const inputCost = IN_TOK * (1 - hit/100) * d.input / 1000;
  const cacheCost = IN_TOK * (hit/100) * d.cache / 1000;
  const outCost = OUT_TOK * d.output / 1000;
  return inputCost + cacheCost + outCost;
}
function render() {
  const p = PRIMARY[s.primary];
  const wPer = workerPer(s.worker, s.cacheHit);
  const primaryPer = (IN_TOK * p.input + OUT_TOK * p.output) / 1000;
  const summaryPer = (SUM_IN * p.input + SUM_OUT * p.output) / 1000;
  const monthly = s.reqs * 30;
  const delegated = monthly * (s.share / 100);
  const kept = monthly - delegated;
  const without = monthly * primaryPer;
  const withT = kept * primaryPer + delegated * (wPer + summaryPer);
  const saved = without - withT;
  document.getElementById("c-reqs").textContent = String(s.reqs);
  document.getElementById("c-share").textContent = s.share + "%";
  document.getElementById("c-without").textContent = money(without);
  document.getElementById("c-with").textContent = money(withT);
  document.getElementById("c-saved").textContent = "saves " + money(saved) + " / month \u00b7 " + Math.round((saved/without)*100) + "% less";
  document.getElementById("c-annual").textContent = money(saved*12);
  const bd = document.getElementById("c-breakdown");
  if (bd) {
    const d = DEEPSEEK[s.worker];
    const inUncached = (IN_TOK * (1 - s.cacheHit/100) * d.input / 1000).toFixed(4);
    const inCache = (IN_TOK * (s.cacheHit/100) * d.cache / 1000).toFixed(5);
    bd.innerHTML = [
      "<div style='display:flex;justify-content:space-between;'><span style='color:var(--color-text-muted);'>Requests / month</span><span style='font-family:var(--font-mono);'>"+monthly.toLocaleString()+"</span></div>",
      "<div style='display:flex;justify-content:space-between;'><span style='color:var(--color-text-muted);'>Kept on primary</span><span style='font-family:var(--font-mono);'>"+Math.round(kept).toLocaleString()+" \u00b7 "+money(kept*primaryPer)+"</span></div>",
      "<div style='display:flex;justify-content:space-between;'><span style='color:var(--color-text-muted);'>Run by worker</span><span style='font-family:var(--font-mono);'>"+Math.round(delegated).toLocaleString()+" \u00b7 "+money(delegated*wPer)+"</span></div>",
      "<div style='display:flex;justify-content:space-between; padding-left:12px;'><span style='color:var(--color-text-label); font-size:11.5px;'>↳ input "+(100-s.cacheHit)+"% @ $"+d.input+" + cache "+s.cacheHit+"% @ $"+d.cache+"</span><span style='font-family:var(--font-mono); font-size:11.5px;'>$"+inUncached+" + $"+inCache+"</span></div>",
      "<div style='display:flex;justify-content:space-between;'><span style='color:var(--color-text-muted);'>Summaries read back</span><span style='font-family:var(--font-mono);'>"+money(delegated*summaryPer)+"</span></div>",
    ].join("");
  }
  document.getElementById("c-mid").style.borderColor = s.primary==="mid" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-mid").style.color = s.primary==="mid" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-mid").setAttribute("aria-pressed", String(s.primary==="mid"));
  document.getElementById("c-top").style.borderColor = s.primary==="top" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-top").style.color = s.primary==="top" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-top").setAttribute("aria-pressed", String(s.primary==="top"));
  document.getElementById("c-flash").style.borderColor = s.worker==="flash" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-flash").style.color = s.worker==="flash" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-flash").setAttribute("aria-pressed", String(s.worker==="flash"));
  document.getElementById("c-pro").style.borderColor = s.worker==="pro" ? "var(--color-accent)" : "var(--color-border-strong)";
  document.getElementById("c-pro").style.color = s.worker==="pro" ? "var(--color-accent)" : "var(--color-text-muted)";
  document.getElementById("c-pro").setAttribute("aria-pressed", String(s.worker==="pro"));
}
document.getElementById("c-reqs-slider").addEventListener("input", e => { s.reqs = parseInt(e.target.value,10); render(); });
document.getElementById("c-share-slider").addEventListener("input", e => { s.share = parseInt(e.target.value,10); render(); });
const cacheSlider = document.getElementById("c-cache-slider");
if (cacheSlider) cacheSlider.addEventListener("input", e => { s.cacheHit = parseInt(e.target.value,10); const el=document.getElementById("c-cache"); if(el) el.textContent=s.cacheHit+"%"; render(); });
document.getElementById("c-mid").addEventListener("click", () => { s.primary="mid"; render(); });
document.getElementById("c-top").addEventListener("click", () => { s.primary="top"; render(); });
document.getElementById("c-flash").addEventListener("click", () => { s.worker="flash"; render(); });
document.getElementById("c-pro").addEventListener("click", () => { s.worker="pro"; render(); });

render();
})();
