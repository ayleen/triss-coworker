# MISTAKES.md — error log for this repository

New entries go on top. Never delete or rewrite past entries.

## Assert the contract, not the schedule

**What happened:** `CODER-LEASE-02` asserted that `slug-a` acquires the target
lease before `slug-b` because it was listed first in `Promise.all`. The test
failed ~1 run in 3 under load — the lease contract guarantees serialization
(no interleaved critical sections), not acquisition order.

**Root cause:** the expected values encoded microtask scheduling order, which
is not part of any contract and varies with event-loop timing.

**Prevention:** for concurrency tests, assert the invariant the primitive
provides (exclusivity, no interleaving, at-most-N concurrent) and accept any
legal order; never assert which racer wins.

## Tests must be written against the contract, not the implementation

**What happened:** `test/coder-credential-proxy.test.js` asserted
`stub.calls[0].url === ENDPOINT + '/v1/chat/completions'` with
`ENDPOINT = 'https://api.provider.example/v1'` — i.e. the test enforced the
doubled-prefix upstream URL (`.../v1/v1/chat/completions`) that the production
proxy was actually building for every provider. CI stayed green while real
model requests could never reach any upstream.

**Root cause:** the expected values were captured from the implementation's
behavior instead of derived from the documented contract ("forward to the
canonical provider endpoint"). A test that encodes observed behavior cannot
detect that the behavior is wrong.

**Prevention:** when writing the expected value for an outbound integration
URL, derive it by hand from the provider's documented API shape
(`origin + /chat/completions`-style) and assert THAT literal. If the assertion
only passes by copying what the code produces, the test is a tautology.

## Forward raw bytes when no transformation is needed

**What happened:** while re-planning the scoped review path,
`selectedDiff` for selector-less reviews was rebuilt from parsed sections
(`sections.map(s => s.raw).join('\n')`). The rebuild dropped bytes that
precede the first `diff --git` header (a BOM line in a byte-exactness test)
and re-joined sections with `\n` regardless of the input's CRLF endings.

**Root cause:** parsing is lossy by design (it re-synthesizes section bytes
from split lines); treating the parser's output as a faithful copy of the
input is wrong even when 99% of bytes coincide.

**Prevention:** when a downstream consumer needs the original bytes and no
selection/filtering is applied, forward the ORIGINAL string; only rebuild from
parsed sections on the path where sections were actually selected/filtered.
