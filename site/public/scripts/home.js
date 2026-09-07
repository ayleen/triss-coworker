// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Homepage progressive enhancement: copy the install command.
// Success is reported only after clipboard.writeText resolves; on failure the
// button tells the user to select and copy manually and the command text is
// selected so a manual copy is one keystroke away. No-JS: the command is a
// normal, always-visible, selectable <code> element.
(function () {
  "use strict";
  var button = document.getElementById("copy-install-btn");
  var command = document.getElementById("install-command");
  if (!button || !command) return;

  var idleLabel = button.textContent;
  var revertTimer = null;

  function setLabel(text, timeout) {
    button.textContent = text;
    if (revertTimer) window.clearTimeout(revertTimer);
    revertTimer = window.setTimeout(function () {
      button.textContent = idleLabel;
    }, timeout);
  }

  function selectCommand() {
    var range = document.createRange();
    range.selectNodeContents(command);
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  button.addEventListener("click", function () {
    var text = command.textContent;
    var succeed = function () {
      setLabel("Copied", 2000);
    };
    var fail = function () {
      selectCommand();
      setLabel("Select and copy the command", 4000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(succeed, fail);
    } else {
      fail();
    }
  });
})();
