// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Enhancement only: every engine panel already exists in the static HTML
// (rendered from site/src/data/coder-reference.js). This script hides
// non-selected panels, syncs button state, and wires the copy bar. Without
// JavaScript the full content stays visible. Panel ids come from the DOM;
// keep them in sync with site/src/data/coder-reference.js.
(function () {
  "use strict";
  var PANELS = Array.prototype.slice.call(document.querySelectorAll("[data-engine-panel]"));
  var engineButtons = Array.prototype.slice.call(document.querySelectorAll(".engine-btn"));
  var engine = "opencode";

  function applySelection() {
    PANELS.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-engine-panel") !== engine;
    });
    engineButtons.forEach(function (button) {
      var on = button.getAttribute("data-engine") === engine;
      button.setAttribute("aria-pressed", String(on));
      button.style.background = on ? "var(--color-accent)" : "transparent";
      button.style.color = on ? "#0b0d10" : "var(--color-text-muted)";
      button.style.borderColor = on ? "var(--color-accent)" : "var(--color-border-strong)";
    });
    var active = PANELS.find(function (panel) { return !panel.hidden; });
    var commandEl = active ? active.querySelector("[data-engine-command]") : null;
    var flag = document.getElementById("engine-flag");
    var bar = document.getElementById("engine-command-bar");
    if (flag && active) flag.textContent = engine + " — see the highlighted panel above";
    if (bar && commandEl) document.getElementById("engine-command").textContent = commandEl.textContent;
  }

  engineButtons.forEach(function (button, index) {
    button.addEventListener("click", function () {
      engine = button.getAttribute("data-engine");
      applySelection();
    });
    button.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      var offset = event.key === "ArrowRight" ? 1 : -1;
      var next = engineButtons[(index + offset + engineButtons.length) % engineButtons.length];
      next.focus();
      next.click();
    });
  });

  var copyButton = document.getElementById("copy-engine-command");
  if (copyButton) {
    copyButton.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(document.getElementById("engine-command").textContent).then(
          function () { copyButton.textContent = "copied"; },
          function () { copyButton.textContent = "copy unavailable"; },
        );
      } else {
        copyButton.textContent = "copy unavailable";
      }
    });
  }

  var bar = document.getElementById("engine-command-bar");
  if (bar) bar.hidden = false;
  applySelection();
})();
