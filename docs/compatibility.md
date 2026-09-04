# Compatibility and stability

| Component | Status |
| --- | --- |
| Core `ask` and `review` CLI | stable |
| MCP protocol surface | beta |
| JSON envelopes | versioned contract |
| OpenCode 1 engine | stable |
| OpenCode 2 engine | beta |
| Crush engine | experimental |
| Oh My Pi (`omp`) engine | supported; pinned minimum plus capability gate |
| Best-effort isolation | limited security boundary |
| Update system | stable |
| Individual integrations | stable or beta as documented by each integration |

Node.js 22 and 24 are tested. Provider availability, model identifiers, and
third-party CLI behavior can change independently of Triss.

OpenCode 2 follows an immutable minimum-version rule: never an exact build pin.
Triss supports the current qualified version and every newer parseable version.
The capability gate checks only required option declarations, never exact help
wording. The configured minimum may raise the current floor but cannot lower
it; lower or malformed values fall back to the built-in floor.
