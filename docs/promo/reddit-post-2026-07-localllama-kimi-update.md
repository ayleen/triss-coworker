# Reddit post — July 2026 — r/LocalLLaMA — monthly update + Kimi K3 hook

**Angle:** Tool update post, first person, casual. Repo link in the body
(decided 2026-07-27). Style guard: no em-dashes, no italics, no bold headers
in the body, no bullet walls, no "actually".
**Target:** r/LocalLLaMA
**Length:** ~300 words, well under one page.

---

## Title

> Kimi K3 weights dropped yesterday, so I wired it into my Claude Code offload tool

## Body

Moonshot put the K3 weights up for download yesterday, and their API is about as simple as it gets (OpenAI compatible, one endpoint). So today I added Kimi support to triss, the small CLI and MCP server I use to stop Claude Code from burning expensive tokens on grunt work.

The idea behind the tool: the expensive model on your Claude plan does the thinking, meaning research, plans and review. Everything else goes to cheap open models. Bulk file reading, fetching web pages, code review passes, and the coding itself once a plan is written. Last month GLM chewed through half a billion coding tokens for me inside a 40 dollar subscription, and my Claude limits never noticed.

Here is what landed over the past month.

GLM became a first class provider. You pass provider glm to ask or review, and it figures out by itself whether your Z.AI key belongs to the coding plan or to pay as you go, instead of dying with a cryptic balance error.

Free models arrived through OpenCode Zen (Tencent hy3 and friends) for the coding agent, if your budget is zero.

A second coding engine (crush) appeared next to opencode, running in a disposable git worktree so it cannot wreck your working tree.

And now Kimi. Reviews and bulk reads go through the Moonshot API, k2.6 for cheap stuff and K3 when you want the big brain. The coding agent can also run on the Kimi for Coding subscription, same flat rate trick as the GLM plan, but with K3 behind it. No endpoint guessing either, the two Kimi plans use different keys, so the tool always knows where to send a request.

All open source: https://github.com/ayleen/triss-coworker

Curious what everyone else puts in the cheap executor seat these days. GLM plan, Kimi, DeepSeek, or something fully local?
