// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Progressive enhancement for the getting-started page.
//
// Contract (implementation plan W09 item 7):
// - Without JavaScript, every labeled variant panel is visible: the server
//   renders all panels from site/src/data/setup.js at build time and nothing
//   is hidden server-side.
// - This script reveals the control groups (package-manager tabs, host
//   target tabs, manual checklist buttons) only after a successful init,
//   then hides the inactive panels with the `hidden` attribute.
// - Default host target: Claude Code. Switching targets preserves the
//   package-manager selection and the checklist progress.
// - The checklist is manual: no install detection, no telemetry, no storage
//   of choices beyond these in-memory session variables.
// - Text updates go through `textContent` only; wiring uses data attributes.
(function () {
  "use strict";

  var state = { pm: "npm", target: "claude", done: {} };
  var els = null;

  function list(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function idsFrom(nodes, attr) {
    var ids = {};
    nodes.forEach(function (node) {
      ids[node.getAttribute(attr)] = true;
    });
    return ids;
  }

  function init() {
    var pmButtons = list("[data-pm]");
    var targetButtons = list("[data-target]");
    var doneButtons = list("[data-step]");
    var installPanels = list("[data-install-panel]");
    var agentPanels = list("[data-agent-panel]");

    els = {
      pmControls: document.querySelector('[data-qs="pm-controls"]'),
      targetControls: document.querySelector('[data-qs="target-controls"]'),
      progress: document.querySelector('[data-qs="progress"]'),
      progressBar: document.getElementById("progress-bar"),
      progressLabel: document.getElementById("progress-label"),
      pmButtons: pmButtons,
      targetButtons: targetButtons,
      doneButtons: doneButtons,
      installPanels: installPanels,
      agentPanels: agentPanels,
    };

    // Abort on any missing piece: the static page stays complete and usable,
    // and the control groups remain hidden instead of showing dead buttons.
    if (
      !els.pmControls ||
      !els.targetControls ||
      !els.progress ||
      !els.progressBar ||
      !els.progressLabel ||
      !pmButtons.length ||
      !targetButtons.length ||
      !doneButtons.length ||
      !installPanels.length ||
      !agentPanels.length
    ) {
      return;
    }

    var pmIds = idsFrom(pmButtons, "data-pm");
    var installIds = idsFrom(installPanels, "data-install-panel");
    var targetIds = idsFrom(targetButtons, "data-target");
    var agentIds = idsFrom(agentPanels, "data-agent-panel");

    var pmComplete = pmButtons.every(function (button) {
      return installIds[button.getAttribute("data-pm")];
    });
    var targetComplete = targetButtons.every(function (button) {
      return agentIds[button.getAttribute("data-target")];
    });
    if (!pmIds[state.pm] || !installIds[state.pm] || !pmComplete) return;
    if (!targetIds[state.target] || !agentIds[state.target] || !targetComplete) return;

    pmButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        state.pm = button.getAttribute("data-pm");
        applyPm();
      });
    });

    targetButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        state.target = button.getAttribute("data-target");
        applyTarget();
      });
    });

    doneButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        var step = button.getAttribute("data-step");
        state.done[step] = !state.done[step];
        button.setAttribute("aria-pressed", state.done[step] ? "true" : "false");
        button.textContent = state.done[step] ? "\u2713 done" : "mark done";
        applyProgress();
      });
    });

    applyPm();
    applyTarget();
    applyProgress();

    els.pmControls.hidden = false;
    els.targetControls.hidden = false;
    els.progress.hidden = false;
  }

  function applyPm() {
    els.pmButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-pm") === state.pm ? "true" : "false");
    });
    els.installPanels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-install-panel") !== state.pm;
    });
  }

  function applyTarget() {
    els.targetButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-target") === state.target ? "true" : "false");
    });
    els.agentPanels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-agent-panel") !== state.target;
    });
  }

  function applyProgress() {
    var count = els.doneButtons.filter(function (button) {
      return state.done[button.getAttribute("data-step")];
    }).length;
    var total = els.doneButtons.length;
    els.progressBar.style.width = (total ? (count / total) * 100 : 0) + "%";
    els.progressLabel.textContent = count + " / " + total + " done";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
