// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export const COMMANDS = [
  { name: "ask", tier: "flash", group: "delegate", body: "Delegate bulk reading to the worker, GLM or Kimi — files, URLs or piped stdin. Returns a structured summary with citations.", flags: ["--paths <glob…>", "--urls <url…>", "--stdin", "--question <text>", "--model flash|pro", "--provider worker|glm|kimi"], example: "$ triss ask --paths \"src/**/*.ts\" --question \"find SQL injection risks\"" },
  { name: "review", tier: "pro", group: "delegate", body: "Code review on branch, PR or piped diff. Concrete file:line issues, not a summary.", flags: ["--base <ref>", "--stdin", "--files <path…>", "--max-tokens 16384"], example: "$ triss review 123\n$ triss review --base develop" },
  { name: "write", tier: "pro", group: "delegate", body: "Delegate boilerplate generation to the worker — spec + reference -> new file.", flags: ["--spec <text>", "--context <file>", "--target <out>"], example: "$ triss write --spec \"pytest for auth.py\" --context tests/test_main.py --target tests/test_auth.py" },
  { name: "fetch", tier: "flash", group: "delegate", body: "Fetch URL(s) and return clean markdown. SSRF-guarded, 30s timeout.", flags: ["--question <text>", "--timeout <ms>"], example: "$ triss fetch https://api-docs.example.com/ --question \"auth header?\"" },
  { name: "chat", tier: "flash", group: "delegate", body: "Bare worker prompt — no corpus. For definitions and transforms.", flags: ["--stdin", "--system <text>", "--model flash|pro", "--max-tokens <n>"], example: "$ triss chat \"explain Raft in 5 bullets\"" },
  { name: "exec", tier: "flash", group: "delegate", body: "Deterministic router to ask/review/coder/chat.", flags: ["[task]", "--stdin"], example: "$ triss exec \"review this diff\"" },
  { name: "commit-msg", tier: "flash", group: "core", body: "Generate Conventional Commits message from staged diff.", flags: ["--apply"], example: "$ git add src/foo.js && triss commit-msg" },
  { name: "extract", tier: "local", group: "core", body: "Convert Claude Code JSONL transcripts to readable text. No model call.", flags: ["<jsonl>", "-o <out>"], example: "$ triss extract ~/.claude/projects/api/s.jsonl -o /tmp/chat.txt" },
  { name: "status", tier: "local", group: "core", body: "Show configuration: API key, models, .env sources.", flags: [], example: "$ triss status" },
  { name: "usage", tier: "local", group: "core", body: "Cumulative cost / tokens. Unknown is never 0.", flags: ["--since 7d", "--by-project", "--reset"], example: "$ triss usage --since 7d --by-label" },
  { name: "agent-help", tier: "local", group: "core", body: "Full delegation cookbook the nano block points to.", flags: [], example: "$ triss agent-help" },
  { name: "config", tier: "local", group: "core", body: "Manage credentials in ~/.config/triss/.env or ./.triss.env.", flags: ["wizard", "set", "get"], example: "$ triss config wizard" },
  { name: "update", tier: "local", group: "core", body: "Check for newer release; update standalone installs.", flags: ["--apply", "--rollback"], example: "$ triss update" },
  { name: "init", tier: "setup", group: "setup", body: "Add triss delegation block to CLAUDE.md / AGENTS.md.", flags: ["--target claude|codex|both", "--global"], example: "$ triss init --target both" },
  { name: "completion", tier: "local", group: "setup", body: "Print shell completion script.", flags: ["bash|zsh"], example: "$ triss completion bash" },
  { name: "coder", tier: "agent", group: "setup", body: "Run a coding agent (opencode/opencode2/crush/omp). OMP uses run-private config and defaults to worktree isolation.", flags: ["run <task>", "--engine opencode|opencode2|crush|omp", "--protect-credentials"], example: "$ triss coder run --engine omp --model opencode-go/deepseek-v4-flash \"Create result.txt containing OMP_OK\"" },
  { name: "mcp", tier: "setup", group: "setup", body: "MCP server: register Triss for Claude Code / Codex.", flags: ["install --target claude|codex|both"], example: "$ triss mcp install --target both" },
  { name: "jira", tier: "setup", group: "trackers", body: "Jira — search, read, create, update, comment, transition.", flags: ["search", "issue", "create"], example: "$ triss jira search \"project=ENG\" --question \"blocked?\"" },
  { name: "linear", tier: "setup", group: "trackers", body: "Linear — issues, projects, initiatives, labels.", flags: ["search", "issue"], example: "$ triss linear search \"Q3\" --question \"unowned?\"" },
  { name: "github", tier: "setup", group: "trackers", body: "GitHub Issues — search, read, create, comment.", flags: ["search", "issue"], example: "$ triss github issue 812 --question \"reproduced?\"" },
  { name: "gitlab", tier: "setup", group: "trackers", body: "GitLab Issues — search, read, create, comment.", flags: ["search", "issue"], example: "$ triss gitlab issue 204 --question \"open?\"" },
  { name: "confluence", tier: "setup", group: "trackers", body: "Confluence — CQL search, read, create, update pages.", flags: ["search", "page"], example: "$ triss confluence search 'space = ENG AND title ~ \"policy\"' --question \"policy?\"" },
];
