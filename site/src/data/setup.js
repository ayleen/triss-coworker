// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Single source of the public command strings and labels rendered on the
// getting-started page. Astro builds every panel from this file at build
// time, so all variants exist in the static HTML. The browser script only
// toggles panel visibility — it must not duplicate these strings.
//
// Rules for this file:
// - public command strings and labels only: no secrets, no user settings,
//   no environment values, no fabricated command output, no version output
//   samples (readers run the commands and read their own output).

export const NODE_CHECK_COMMAND = "node --version";

// Package-manager install variants for step 2. The first entry (npm) is the
// default selection; the Astro page renders one labeled panel per entry.
export const PACKAGE_MANAGERS = [
  { id: "npm", label: "npm", command: "npm install -g triss-coworker" },
  { id: "pnpm", label: "pnpm", command: "pnpm add -g triss-coworker" },
  { id: "yarn", label: "yarn", command: "yarn global add triss-coworker" },
];

// npm-free standalone installer (install.sh at the repository root).
export const STANDALONE_INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/ayleen/triss-coworker/main/install.sh | bash";

// Install from a checkout of the repository.
export const SOURCE_INSTALL_COMMANDS = [
  "git clone https://github.com/ayleen/triss-coworker.git",
  "cd triss-coworker && npm install && npm link",
  "triss --version && triss status",
];

// Provider configuration and verification (step 3). Standard mode is the
// factual default: it configures the openai-compatible profile and then wires
// MCP + rules for both hosts without asking. Other providers go through the
// advanced wizard; a terminal-only setup can set the same profile directly.
export const WIZARD_COMMAND = "triss config wizard";
export const STANDARD_WIZARD_COMMAND = "triss config wizard --standard";
export const ADVANCED_WIZARD_COMMAND = "triss config wizard --advanced";
export const TERMINAL_PROVIDER_COMMANDS = [
  "triss config set -g TRISS_OPENAI_COMPATIBLE_API_KEY <your key>",
  "triss config set -g TRISS_OPENAI_COMPATIBLE_MODEL <main model>",
  "triss config set -g TRISS_OPENAI_COMPATIBLE_SMALL_MODEL <small model>",
];
export const STATUS_COMMAND = "triss status";

// First delegated task (step 5). Example input for a project that has a
// README.md; no canned output belongs anywhere on the page.
export const FIRST_TASK_COMMAND_LINES = [
  "triss ask --paths README.md \\",
  '    --question "What does this project do, and which setup steps does its README require? Cite the relevant lines."',
];

// Host-connection guides (step 4). The setup comment strings are part of the
// published command block and must stay verbatim. The terminal target needs
// no host setup, so it carries no commands.
export const AGENT_TARGETS = [
  {
    id: "claude",
    label: "Claude Code",
    setupComment: "# Claude Code — explicit global setup",
    setupCommands: [
      "triss mcp install --target claude --global",
      "triss init --target claude --global",
    ],
  },
  {
    id: "codex",
    label: "Codex",
    setupComment: "# Codex — explicit global setup",
    setupCommands: [
      "triss mcp install --target codex --global",
      "triss init --target codex --global",
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    setupComment: "",
    setupCommands: [],
  },
];

export const AGENT_HELP_COMMAND = "triss agent-help";
export const MCP_STATUS_COMMAND = "triss mcp status";

// Pre-0.42 migration (kept verbatim from the published upgrade guidance).
export const UPGRADE_042_COMMANDS = ["triss migrate", "triss status"];

// Optional advanced engine setups, moved below the five steps. Versions are
// supported floors from the repository (src/coder-engines/*, docs/engines/*),
// not pinned demo releases.
export const OPENCODE2_SETUP_COMMANDS = [
  "npm install -g @opencode-ai/cli@beta",
  "triss coder init --engine opencode2 --provider opencode-zen",
  'triss coder run --engine opencode2 --model opencode-zen/deepseek-v4-flash-free "Implement the task"',
];

export const OMP_SETUP_COMMANDS = [
  "curl https://omp.sh/install | sh",
  "triss coder init --engine omp --provider opencode-go",
  'triss coder run --engine omp --model opencode-go/deepseek-v4-flash "Create result.txt containing OMP_OK"',
];

export const MUSE_SETUP_COMMANDS = [
  "triss coder init --engine opencode --provider opencode-go",
  "triss config set TRISS_DEFAULT_PROVIDER opencode-go",
  "triss config set TRISS_DEFAULT_ENGINE opencode",
  "triss config set TRISS_OPENCODE_GO_MODEL muse-spark-1.3-contributor",
  "triss config set TRISS_OPENCODE_GO_SMALL_MODEL muse-spark-1.3-contributor",
  'triss ask --paths \'src/**/*.js\' --question "find correctness defects"',
  "triss review",
];
