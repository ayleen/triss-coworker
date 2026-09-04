# OpenCode Go provider

OpenCode Go is the canonical `opencode-go` provider. It shares `OPENCODE_API_KEY` with Zen but owns an independent endpoint and model roles.

```bash
triss coder init --engine opencode --provider opencode-go
triss coder run --engine opencode \
  --model opencode-go/deepseek-v4-flash \
  "Implement the task"
```

## Configuration

| Field | Value |
|---|---|
| Credential | `OPENCODE_API_KEY` |
| Endpoint | `TRISS_OPENCODE_GO_BASE_URL` |
| Main role | `TRISS_OPENCODE_GO_MODEL` |
| Small role | `TRISS_OPENCODE_GO_SMALL_MODEL` |

Initialization fetches the authenticated catalogue. HTTP 401/403, malformed data, an authoritative empty catalogue, and unsupported model transport metadata fail closed. A temporary catalogue failure can use the documented `--allow-unverified` init path only where the CLI explicitly permits it; it never bypasses authentication failures.

Protected execution admits only models with audited transport metadata. OpenAI Chat, OpenAI Responses, and Anthropic Messages projections are selected per model rather than guessed from the provider.

## Request identification and traffic safety

Every audited OpenCode Go request sent by the `opencode` engine must retain an
engine provider ID beginning with `opencode`. OpenCode uses that identity to add
the request-scoped `x-opencode-session`, `x-opencode-request`, and
`x-opencode-client` headers plus a specific `User-Agent` beginning with
`opencode/<installed-version>`. Triss must not replace these with a generic user
agent or a static session value when it projects an audited transport through a
transient provider.

OpenCode also derives `x-opencode-project` from the repository root commit,
which is a stable project fingerprint. Protected-proxy execution deliberately
drops that header; direct best-effort execution is not a metadata-minimizing
boundary and sends OpenCode's native headers unchanged.

The required `opencode` provider prefix deliberately selects the rest of
OpenCode V1's native Go/Zen behavior as well. For `@ai-sdk/openai` transports
that includes the session prompt-cache key, provider-managed `include` values,
and automatic reasoning summaries. It also enables OpenCode's supported
provider path and the native `0.95` default temperature for
`deepseek-v4-flash`. Triss pins `small_model`, so OpenCode's default
`gpt-nano` small-model family is not selected. Release validation must include
a live Go request because these behaviors affect the upstream request body,
not only its headers.

Triss admits one child process per coder run. Non-isolated runs against the same
project are serialized, isolated runs are bounded by the four session slots,
and every run has a finite timeout (900 seconds by default). The supervisor
terminates the process group on the deadline or a detected provider rate-limit
response; Triss does not restart or resubmit the completed run automatically.
The supported OpenCode runtime honors bounded, valid `Retry-After` and
`Retry-After-Ms` response metadata, uses exponential backoff with jitter when
the provider supplies neither header, and stops after five retries for
retryable provider failures. Protected-proxy execution preserves those
upstream retry headers. Its sustained-rate limiter returns `Retry-After: 1`;
the 1,000-request total cap is terminal for that run and intentionally returns
no retry metadata. Protected-proxy execution adds the hard limit of 20 requests
per second.

Acceptance criteria:

- audited Go and Zen transient provider IDs used by OpenCode begin with
  `opencode`, including a separate small-model transport;
- unrelated providers retain the private `triss-coder-transient` namespace;
- persistent OpenCode configuration cannot redefine any generated transient
  provider ID;
- protected-proxy execution forwards only the bounded OpenCode
  `User-Agent`, session, request, and client request-header allowlist; it drops
  the repository-derived `x-opencode-project` fingerprint, preserves only
  bounded and valid upstream retry response metadata, and replaces the
  loopback token with the real upstream credential;
- focused provider-routing and coder-run tests cover the generated selectors,
  effective configuration, and public envelope identity;
- release validation exercises a live OpenCode Go request, not only mocks.

## Account state

A catalogue entry does not prove account entitlement, quota, balance, or regional-hosting opt-in. Triss reports the provider response and never changes account, billing, privacy, or regional settings.

Update roles with canonical fields, then rerun init:

```bash
triss config set TRISS_OPENCODE_GO_MODEL <native-id>
triss config set TRISS_OPENCODE_GO_SMALL_MODEL <native-id>
triss coder init --engine opencode --provider opencode-go
```
