// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export const COMMANDS = [
  { name: "ask", tier: "small", group: "delegate", body: "Answer from files, URLs, or stdin through the canonical provider runtime.", flags: ["--paths <glob…>", "--urls <url…>", "--question <text>", "--provider <id>", "--model <native-id>", "--engine <id>", "--effort <level>"], example: "$ triss ask --provider zai --model glm-5.2 --effort high --paths src --question \"find correctness defects\"" },
  { name: "review", tier: "main", group: "delegate", body: "Code review on a branch, PR, selected files, or piped diff.", flags: ["--base <ref>", "--stdin", "--files <path…>", "--provider <id>", "--model <native-id>", "--engine <id>", "--effort <level>"], example: "$ triss review --provider moonshot --model kimi-k3" },
  { name: "write", tier: "main", group: "delegate", body: "Generate boilerplate from a specification and optional reference file.", flags: ["--spec <text>", "--context <file>", "--target <out>", "--provider <id>"], example: "$ triss write --spec \"pytest for auth.py\" --context tests/test_main.py --target tests/test_auth.py" },
  { name: "fetch", tier: "small", group: "delegate", body: "Fetch readable Markdown with bounded redirects and optional provider-backed summary.", flags: ["--question <text>", "--timeout <ms>"], example: "$ triss fetch https://api-docs.example.com/ --question \"auth header?\"" },
  { name: "chat", tier: "small", group: "delegate", body: "Run a prompt without a corpus.", flags: ["--stdin", "--system <text>", "--provider <id>", "--model <native-id>", "--effort <level>"], example: "$ triss chat --effort low \"explain Raft in 5 bullets\"" },
  { name: "exec", tier: "small", group: "delegate", body: "Deterministically route to ask, review, coder, or chat.", flags: ["[task]", "--stdin", "--explain"], example: "$ triss exec --explain \"review this diff\"" },
  { name: "commit-msg", tier: "small", group: "core", body: "Generate a Conventional Commits message from staged changes.", flags: ["--apply"], example: "$ git add src/foo.js && triss commit-msg" },
  { name: "extract", tier: "local", group: "core", body: "Convert host JSONL transcripts to readable text without a model call.", flags: ["<jsonl>", "-o <out>"], example: "$ triss extract session.jsonl -o /tmp/chat.txt" },
  { name: "status", tier: "local", group: "core", body: "Show migration, provider, engine, and integration readiness.", flags: [], example: "$ triss status" },
  { name: "migrate", tier: "local", group: "core", body: "Transactionally migrate pre-0.42 configuration to canonical provider profiles.", flags: [], example: "$ triss migrate && triss status" },
  { name: "usage", tier: "local", group: "core", body: "Report canonical token and cost records. Unknown is never zero.", flags: ["--since 7d", "--by-project", "--reset"], example: "$ triss usage --since 7d --by-label" },
  { name: "agent-help", tier: "local", group: "core", body: "Print the full delegation cookbook.", flags: [], example: "$ triss agent-help" },
  { name: "config", tier: "local", group: "core", body: "Manage global and project provider profiles and integration credentials.", flags: ["wizard", "set", "get", "list"], example: "$ triss config wizard" },
  { name: "update", tier: "local", group: "core", body: "Check for a release and update supported standalone installs.", flags: ["--apply", "--rollback"], example: "$ triss update" },
  { name: "init", tier: "setup", group: "setup", body: "Add the Triss delegation block to host-agent rules.", flags: ["--target claude|codex|both", "--global"], example: "$ triss init --target both" },
  { name: "completion", tier: "local", group: "setup", body: "Print a shell completion script.", flags: ["bash|zsh"], example: "$ triss completion bash" },
  { name: "coder", tier: "agent", group: "setup", body: "Run a coding agent through opencode, opencode2, crush, or omp.", flags: ["run <task>", "--engine opencode|opencode2|crush|omp", "--model <provider/id>", "--effort <level>", "--protect-credentials"], example: "$ triss coder run --engine omp --model opencode-go/deepseek-v4-flash --effort high \"Create result.txt\"" },
  { name: "mcp", tier: "setup", group: "setup", body: "Register Triss as an MCP server for Claude Code or Codex.", flags: ["install --target claude|codex|both"], example: "$ triss mcp install --target both" },
  { name: "jira", tier: "setup", group: "trackers", body: "Search and mutate Jira issues.", flags: ["search", "issue", "create"], example: "$ triss jira search \"project=ENG\" --question \"blocked?\"" },
  { name: "linear", tier: "setup", group: "trackers", body: "Search Linear issues, projects, and initiatives.", flags: ["search", "issue"], example: "$ triss linear search \"Q3\" --question \"unowned?\"" },
  { name: "github", tier: "setup", group: "trackers", body: "Search and mutate GitHub issues.", flags: ["search", "issue"], example: "$ triss github issue 812 --question \"reproduced?\"" },
  { name: "gitlab", tier: "setup", group: "trackers", body: "Search and mutate GitLab issues.", flags: ["search", "issue"], example: "$ triss gitlab issue 204 --question \"open?\"" },
  { name: "confluence", tier: "setup", group: "trackers", body: "Search and update Confluence pages.", flags: ["search", "page"], example: "$ triss confluence search 'space = ENG' --question \"policy?\"" },
];
