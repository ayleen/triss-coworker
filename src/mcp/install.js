// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Manage the Triss MCP-server registration in agent configs.
//
// Two agents are supported via opts.target:
//   claude (default) — JSON in ~/.claude.json (global) or <cwd>/.mcp.json (local)
//   codex            — TOML in ~/.codex/config.toml (global only)
//
// For Claude we own the `mcpServers.triss` JSON key. For Codex we own the
// `[mcp_servers.triss]` and `[mcp_servers.triss.env]` TOML sections; everything
// else in the TOML file is preserved byte-for-byte (we don't fully parse TOML
// — we just locate and surgically replace our block).

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicReplace, canonicalTargetPath } from '../marker-transaction.js';
import { projectRoot } from '../safety.js';

const SERVER_NAME = 'triss';

// Codex defaults. The outer tool timeout must exceed 3 × the selected
// per-attempt timeout plus headroom, because the OpenAI SDK keeps its retries
// enabled (default 2 retries, so 3 attempts total) and each attempt may run
// the full per-attempt timeout. For the default 30-minute GLM-review timeout
// (GLM_REVIEW_TIMEOUT_MS, an internal constant) that is 3 × 1800s + 60s
// headroom = 5460s. Without that, a thinking GLM review that retries inside
// triss could be killed by a shorter host-side cap before the model finishes.
// Users who raise the per-attempt timeout above 1800000 ms (via
// TRISS_REQUEST_TIMEOUT_MS or the MCP timeout_ms argument) must raise
// tool_timeout_sec to at least 3 × that value plus headroom. The startup
// timeout stays short (30s) — it only bounds process launch, not tool
// execution.
const CODEX_STARTUP_TIMEOUT_SEC = 30;
const CODEX_TOOL_TIMEOUT_SEC = 5460;
// tool_timeout_sec written by Triss versions before the outer tool timeout was
// raised to cover the OpenAI SDK's retries. Migrate exactly this value and
// nothing else (see migrateCodexToolTimeout below).
const HISTORICAL_CODEX_TOOL_TIMEOUT_SEC = 120;

function normTarget(t) {
  const v = (t || 'claude').toLowerCase();
  if (v !== 'claude' && v !== 'codex') {
    throw new Error(`Unknown MCP target "${t}". Supported: claude, codex`);
  }
  return v;
}

export function configPath(scope, target = 'claude') {
  const t = normTarget(target);
  if (t === 'codex') {
    if (scope === 'local') {
      throw new Error(
        "Codex doesn't support project-local MCP config — use --global (~/.codex/config.toml)",
      );
    }
    return join(homedir(), '.codex', 'config.toml');
  }
  if (scope === 'local') return join(process.cwd(), '.mcp.json');
  return join(homedir(), '.claude.json');
}

// ─── Claude (JSON) ───────────────────────────────────────────────────────────

function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`, { cause: err });
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

// Build the JSON entry written to ~/.claude.json or ./.mcp.json.
//
// `scope` controls TRISS_PROJECT_ROOT pinning. The variable hardwires the
// MCP-server sandbox to a specific directory; that's correct only when the
// config file itself lives inside that directory (project-local .mcp.json).
// In a *global* config it would silently sandbox every Claude Code session
// — regardless of which project it is launched in — to a single fixed path,
// which is exactly the bug we want to avoid (see #issues/multi-root). For
// global scope we leave TRISS_PROJECT_ROOT unset so projectRoot() falls
// back to process.cwd(), which Claude Code sets per project.
function claudeEntry(opts, scope) {
  const entry = {
    command: opts.command || SERVER_NAME,
    args: opts.args || ['mcp', 'serve'],
  };
  const customEnv = opts.env || {};
  if (scope === 'local') {
    const root = opts.projectRoot || projectRoot();
    entry.env = { ...customEnv, TRISS_PROJECT_ROOT: root };
  } else if (Object.keys(customEnv).length) {
    entry.env = { ...customEnv };
  }
  return entry;
}

function installClaude(scope, opts) {
  const path = configPath(scope, 'claude');
  const config = readJson(path);
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const existing = config.mcpServers[SERVER_NAME];
  const oldRoot = existing?.env?.TRISS_PROJECT_ROOT || null;
  const next = claudeEntry(opts, scope);
  config.mcpServers[SERVER_NAME] = next;
  writeJson(path, config);
  const result = { path, status: existing ? 'updated' : 'added', target: 'claude' };
  // Only surface migration when we actively dropped a stale pin; if the new
  // entry still has a TRISS_PROJECT_ROOT (local install), the value just got
  // refreshed and there's nothing for the user to act on.
  if (oldRoot && !next.env?.TRISS_PROJECT_ROOT) {
    result.migratedFrom = oldRoot;
  }
  return result;
}

function uninstallClaude(scope) {
  const path = configPath(scope, 'claude');
  if (!existsSync(path)) return { path, status: 'absent', target: 'claude' };
  const config = readJson(path);
  if (!config.mcpServers?.[SERVER_NAME]) {
    return { path, status: 'absent', target: 'claude' };
  }
  delete config.mcpServers[SERVER_NAME];
  writeJson(path, config);
  return { path, status: 'removed', target: 'claude' };
}

function statusClaude(scope) {
  const path = configPath(scope, 'claude');
  if (!existsSync(path)) return { path, present: false, target: 'claude' };
  const config = readJson(path);
  return {
    path,
    target: 'claude',
    present: !!config.mcpServers?.[SERVER_NAME],
    entry: config.mcpServers?.[SERVER_NAME] || null,
  };
}

// ─── Codex (TOML) ────────────────────────────────────────────────────────────

// Parts-based Triss header predicates. These operate on the parsed key PARTS
// of a header — never on the joined dotted text, which loses component
// boundaries: ["mcp_servers"."triss"] is TWO components and names the same
// table as the generated bare [mcp_servers.triss], while
// ["mcp_servers.triss"] is ONE component whose literal name contains a dot —
// a completely different table whose dotted text merely collides.

// The Triss root table: a single-bracket header whose first two key
// components are `mcp_servers` and `triss`, quoted or bare. Quoting never
// changes which table a dotted key names, so ["mcp_servers"."triss"] and
// ["mcp_servers".triss] (mixed quoting) are this same table. The
// single-component ["mcp_servers.triss"] is not (it has one part).
function isTrissRoot(parts) {
  return (
    parts.length === 2 &&
    parts[0].text === 'mcp_servers' &&
    parts[1].text === 'triss'
  );
}

// A sub-table OF the Triss root (e.g. [mcp_servers.triss.env] in any quoting
// style): its first two components are mcp_servers / triss and it has more.
// ["mcp_servers.triss".env] is a sub-table of the single-component
// "mcp_servers.triss" table — a different table — so it is never ours.
function isTrissSection(parts) {
  return (
    parts.length > 2 &&
    parts[0].text === 'mcp_servers' &&
    parts[1].text === 'triss'
  );
}

// Conservative line-based TOML scanner (no dependency on a TOML parser).
//
// The Codex migration only ever rewrites one integer token, so it needs just
// enough lexical structure to know where the root [mcp_servers.triss] table
// lives and where it ends. A naive regex is fooled by constructs whose text
// happens to look like a header or a key assignment, so the scanner tracks
// the only constructs that can hide them:
//   - multi-line basic ("""…""") and literal ('''…''') strings, which can
//     span lines and contain any text — including lines that look exactly
//     like `[mcp_servers.triss]` or `tool_timeout_sec = 120`;
//   - single-line basic/literal strings and `#` comments inside a line
//     (an escaped quote never closes a string). The index span of every
//     complete single-line string is recorded per line (`strings`), so
//     callers that text-scan a line (previousCodexProjectRoot) can skip
//     matches that fall inside string content;
//   - quoted dotted keys in table headers — `["mcp_servers"."triss"]` is a
//     valid header naming the SAME table as the bare form (quoting never
//     changes which table a dotted key names), but the automatic legacy-timeout
//     migration is deliberately narrow and only ever rewrites the exact bare
//     header triss generated, so any quoted header must stop the prior table
//     scan like any other header. The installer treats the two-component
//     quoted/mixed root as the same table (see findTrissBlock's `semantic`
//     mode); the single-component `["mcp_servers.triss"]` is a DIFFERENT
//     table, and an array-of-tables header (`[[mcp_servers.triss]]`, or a
//     quoted/mixed two-component spelling of it) is a DIFFERENT shape — an
//     array of tables — that is never a regular block (see
//     findTrissAotRoots).
//   - square/curly container nesting outside strings/comments: a valid
//     multi-line array may hold array elements that themselves open with `[`
//     on their own line (`[1, 2],` inside an array of arrays) or inline
//     tables — those lines are VALUES inside an open container, never table
//     headers, so only lines that start at container depth zero can be
//     headers; a line that merely starts inside an open container never marks
//     the file malformed.
// A multi-line string inherited from a previous line is scanned with the same
// whole-line lexer, so a closing delimiter followed by more array content
// (`""",` — valid inside a TOML array) closes the string and keeps lexing the
// comma, further elements, and comments instead of rejecting the file.
// Container nesting is a TYPED stack of expected closers, not a bare depth: a
// `]` must close the `[` that is currently open and a `}` must close a `{`, so
// a mismatched closer (`}` where a `[` is open, or the reverse) or a stray
// closer with nothing open marks the file malformed instead of being clamped
// back to zero — a file that returned to "depth zero" through the wrong closer
// must never be trusted enough to rewrite.
// The scanner is deliberately conservative: an unterminated multi-line string,
// an open container at EOF, a mismatched or stray closing delimiter, a single-
// line string left open at the end of its line (TOML single-line strings can
// never span a newline), an invalid backslash escape in a basic string
// (single- or multi-line; see consumeBasicStringEscape), or a header-like
// line that does not parse as a valid TOML table header marks the whole file
// as lexically ambiguous, and the migration then leaves the config
// byte-for-byte untouched instead of guessing.

// TOML bare keys — in both 1.0 and the official 1.1 draft — remain
// ASCII-only (A-Za-z0-9_-). TOML 1.1 does NOT widen bare keys to Unicode;
// a non-ASCII key component must be quoted. The regex below is therefore
// intentionally the 1.0/1.1 shared set, never extended.
const BARE_KEY_RE = /^[A-Za-z0-9_-]+/;

// Single-character escapes TOML basic strings support. The repo targets TOML
// 1.1, which keeps the 1.0 escape set — \b \t \n \f \r \" \\ — and adds \e
// (U+001B) and the fixed-width 8-bit \xHH escape; \uHHHH and \UHHHHHHHH were
// already in 1.0. A backslash followed by anything else is NOT a valid
// basic-string escape and makes the header fail closed.
const BASIC_STRING_ESCAPES = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\u001b',
  '"': '"',
  '\\': '\\',
};

const HEX_ESCAPE_DIGITS = { x: 2, u: 4, U: 8 };

// Consume a TOML basic-string escape that starts at `line[i]` (which must be
// a backslash) and return the index just past it, or null when the escape is
// not valid TOML. `multiline` enables the line-ending-backslash forms that
// only exist in multi-line basic strings: a bare `\` at end of line, and a
// `\` followed by spaces/tabs then end of line (kept from TOML 1.0, a strict
// superset of 1.1 — never rejecting a valid old file). Single-line basic
// strings validate the same escape set as the header-key parser
// (parseHeaderBody): \b \t \n \f \r \" \\ \e \uHHHH \UHHHHHHHH \xHH — a
// dangling backslash or any other following character is invalid. A
// fixed-width hex escape must be followed by exactly 2 (\x), 4 (\u) or 8
// (\U) hex digits decoding to a non-surrogate scalar value; a partial run of
// hex digits (truncated by the closing quote or end of line) is invalid.
// Literal strings never process escapes, so callers only use this for basic
// strings.
function consumeBasicStringEscape(line, i, multiline) {
  if (i + 1 >= line.length) {
    // A dangling backslash is valid only as a multi-line line-ending
    // backslash; in a single-line basic string it escapes nothing and the
    // string stays open at EOL (malformed).
    return multiline ? i + 1 : null;
  }
  const esc = line[i + 1];
  if (multiline && (esc === ' ' || esc === '\t')) {
    // TOML 1.0 also allowed a backslash followed by whitespace before the
    // newline; accept it so a valid old file is never flagged. Whitespace
    // followed by more content (not EOL) is not a line-ending backslash and
    // falls through to the escape check on `esc` below — invalid.
    let j = i + 1;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j += 1;
    if (j >= line.length) return i + 1; // backslash + whitespace to EOL
  }
  const single = BASIC_STRING_ESCAPES[esc];
  if (single !== undefined) return i + 2;
  const digits = HEX_ESCAPE_DIGITS[esc];
  if (digits !== undefined) {
    const hex = line.slice(i + 2, i + 2 + digits);
    if (hex.length === digits && /^[0-9A-Fa-f]+$/.test(hex)) {
      const value = parseInt(hex, 16);
      if (value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) {
        return i + 2 + digits;
      }
    }
    return null;
  }
  return null;
}

// Split a header body into dotted key parts, each bare or quoted. Returns
// null when the body is not a valid dotted key list. A dot must ALWAYS be
// followed by another key part: `mcp_servers.triss.` (trailing dot) is not a
// valid header body and returns null, so header-like lines that end in a dot
// are rejected as malformed instead of silently accepting the empty last
// part. Reaching the end of the body between parts (right after a dot, or
// with an empty body) is the only way this returns null besides a lexical
// error in a part itself.
function parseHeaderBody(body) {
  const parts = [];
  let i = 0;
  for (;;) {
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (i >= body.length) return null; // empty body or a dot with no part after it
    const c = body[i];
    let text;
    let quoted;
    if (c === '"') {
      // Basic quoted key: backslash escapes are DECODED exactly as TOML
      // defines them for basic strings. A bare key written as
      // ["mcp\u005Fservers"."triss"] names the same two components as
      // ["mcp_servers"."triss"], while ["mcp_servers\u002Etriss"] decodes to
      // ONE component whose literal name contains a dot — a different table.
      // Literal quoted keys (single quotes, below) never decode escapes.
      let j = i + 1;
      let out = '';
      while (j < body.length) {
        if (body[j] === '\\') {
          if (j + 1 >= body.length) return null; // dangling backslash
          const esc = body[j + 1];
          const single = BASIC_STRING_ESCAPES[esc];
          if (single !== undefined) {
            out += single;
            j += 2;
            continue;
          }
          const digits = HEX_ESCAPE_DIGITS[esc];
          if (digits !== undefined) {
            // Fixed-width hex escape: exactly 2 (\x), 4 (\u) or 8 (\U) hex
            // digits, decoded to a Unicode scalar value. Fewer digits (an
            // escape truncated by the closing quote or end of string), a
            // non-hex digit, a surrogate code point (U+D800–U+DFFF), or a
            // value above U+10FFFF all make the key undecodable — the header
            // is malformed and the file fails closed rather than guessing.
            const hex = body.slice(j + 2, j + 2 + digits);
            if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
            const value = parseInt(hex, 16);
            if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null;
            out += String.fromCodePoint(value);
            j += 2 + digits;
            continue;
          }
          return null; // unknown escape — fail closed
        }
        if (body[j] === '"') break;
        out += body[j];
        j += 1;
      }
      if (j >= body.length) return null; // unterminated quoted key
      text = out;
      quoted = true;
      i = j + 1;
    } else if (c === "'") {
      const end = body.indexOf("'", i + 1);
      if (end < 0) return null;
      text = body.slice(i + 1, end);
      quoted = true;
      i = end + 1;
    } else {
      const m = body.slice(i).match(BARE_KEY_RE);
      if (!m) return null;
      text = m[0];
      quoted = false;
      i += m[0].length;
    }
    parts.push({ text, quoted });
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (i >= body.length) break; // clean end of body — a part was just parsed
    if (body[i] !== '.') return null;
    i += 1;
    // loop: the next iteration MUST parse a key part (or return null above)
  }
  if (!parts.length) return null;
  return {
    parts,
    dotted: parts.map((p) => p.text).join('.'),
    quoted: parts.some((p) => p.quoted),
  };
}

// Parse a header line whose code starts with `[` (after whitespace, comment
// already stripped). Returns the parsed header or null when the line is not a
// valid TOML table header. The parsed header carries the raw key PARTS — each
// { text, quoted } — plus the joined dotted text and a `quoted` flag; the
// parts preserve component boundaries that the joined text loses
// (["mcp_servers"."triss"] is two parts, ["mcp_servers.triss"] is one).
export function parseHeaderLine(code) {
  const trimmed = code.trimStart();
  const isArray = trimmed.startsWith('[[');
  const openLen = isArray ? 2 : 1;
  if (trimmed.length <= openLen) return null;
  let i = openLen;
  let quote = null;
  let body = '';
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (quote === 'literal') {
      if (c === "'") quote = null;
      body += c;
      i += 1;
      continue;
    }
    if (quote === 'basic') {
      if (c === '\\') {
        if (i + 1 >= trimmed.length) return null;
        body += c + trimmed[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      body += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = 'basic';
      body += c;
      i += 1;
      continue;
    }
    if (c === "'") {
      quote = 'literal';
      body += c;
      i += 1;
      continue;
    }
    if (c === ']') {
      if (!isArray) {
        const rest = trimmed.slice(i + 1);
        if (!/^\s*(?:#.*)?$/.test(rest)) return null;
        const header = parseHeaderBody(body);
        return header ? { ...header, isArray: false } : null;
      }
      if (trimmed[i + 1] === ']') {
        const rest = trimmed.slice(i + 2);
        if (!/^\s*(?:#.*)?$/.test(rest)) return null;
        const header = parseHeaderBody(body);
        return header ? { ...header, isArray: true } : null;
      }
      return null;
    }
    body += c;
    i += 1;
  }
  return null; // header never closed
}

// Return the code portion of a line — everything before the first top-level
// `#` comment — plus the kind of multi-line string still open at the END of
// the line (null | 'basic' | 'literal'), the square/curly container nesting
// stack at the END of the line, whether the line lexed a mismatched or
// stray closing delimiter or a single-line string left open at EOL, the
// index spans (inclusive start, exclusive end) of every complete
// SINGLE-LINE basic/literal string on the line, and the spans of every
// MULTI-LINE basic/literal string that OPENS on the line (see below).
// `startMultiline` is the multi-line string state
// inherited from the previous line (null when the line starts outside any
// string); `startStack` is the container nesting stack inherited from the
// previous line — each entry is the closer (`']'` or `'}'`) expected to close
// the opener that pushed it. A `#` inside a single-line string is content,
// not a comment. The scanner tracks real lexical state across the whole line:
// a multi-line string may open AND close on the same line (`note = """text"""`
// leaves no residual state), a closing delimiter never reopens a string, a
// line that STARTS inside a multi-line string is scanned from that state
// onward — so `""",` (a closing delimiter followed by array punctuation)
// closes the string and keeps lexing the comma, further strings, and comments
// — and multiple strings / array punctuation on one line (`["""a""", "b"]`)
// lex correctly — comments only ever start outside strings.
// Every multi-line string that OPENS on the line — mid-line, never as a
// leftover from a previous line — is recorded in `multilineSpans`: when it
// closes on the same line the span runs from its opener to the closing
// delimiter (`note = """text"""`, including one inside a same-line container
// like `values = ["""a""", "b"]`), and when it stays open at EOL the span
// runs from the opener to the end of the line — every byte after the opener
// is string content. Lines that START inside a multi-line string are skipped
// wholesale by callers via `inMultiline`, so only strings that open on the
// line itself need a recorded span; a caller text-scanning a line
// (previousCodexProjectRoot) must skip any match that overlaps a span here
// just like it skips `strings`. `[` / `{` outside
// strings and comments push their expected closer onto the stack and `]` / `}`
// close the matching opener: a multi-line array whose elements are themselves
// arrays (`[1, 2],`) or inline tables therefore keeps the stack non-empty for
// every element line. The stack is TYPED, so a closer must match the opener
// that is currently open: on `]` the top of the stack must be `]`, on `}` it
// must be `}`. A mismatched closer (a `}` closing a `[`, or a `]` closing a
// `{`) or a stray closer with an empty stack marks the line malformed instead
// of being clamped to zero — that file cannot be trusted, so the migration
// must refuse to rewrite it. Table headers are balanced (`[mcp_servers.triss]`,
// `[[a]]`, `["a"."b"]`), so a header line always leaves the stack back where
// it started. A single-line basic/literal string still open at the end of the
// line is also malformed: TOML single-line strings can never span a newline
// (a trailing backslash in a basic string only escapes the quote that would
// have closed it), so an unterminated quote must never be discarded at EOL —
// discarding it would let a later fake-looking `[mcp_servers.triss]` line be
// processed and the migration rewrite a syntactically broken config. A
// BACKSLASH ESCAPE inside a basic string — single-line or multi-line — is
// validated against the TOML escape set (see consumeBasicStringEscape): an
// invalid escape (\q, an incomplete fixed-width hex escape, a
// surrogate/out-of-range codepoint) marks the line malformed the same way,
// because such a string is lexically invalid TOML and a file containing it
// must never be rewritten. Literal strings never process escapes, so `\q`
// inside a literal string is plain content and stays valid.
function codeBeforeComment(line, startMultiline = null, startStack = []) {
  let i = 0;
  let quote = null; // single-line string state: null | 'basic' | 'literal'
  let multiline = startMultiline; // multi-line string state: null | 'basic' | 'literal'
  const stack = startStack.slice(); // expected closers for open containers
  const stringSpans = []; // complete single-line string spans on this line
  const multilineSpans = []; // spans of multi-line strings that OPEN on this line
  let stringStart = null; // index of the opening quote of the open single-line string
  let multilineStart = null; // index where the multi-line string open on this line began
  let malformed = false; // a mismatched or stray closing delimiter was seen
  while (i < line.length) {
    const c = line[i];
    if (quote === 'literal') {
      if (c === "'") {
        quote = null;
        stringSpans.push({ start: stringStart, end: i + 1 });
        stringStart = null;
      }
      i += 1;
      continue;
    }
    if (quote === 'basic') {
      if (c === '\\') {
        const next = consumeBasicStringEscape(line, i, false);
        if (next === null) malformed = true;
        i = next === null ? i + 1 : next;
        continue;
      }
      if (c === '"') {
        quote = null;
        stringSpans.push({ start: stringStart, end: i + 1 });
        stringStart = null;
      }
      i += 1;
      continue;
    }
    if (multiline === 'literal') {
      let run = 0;
      while (line[i + run] === "'") run += 1;
      if (run >= 3) {
        multiline = null;
        // The string opened on THIS line (not inherited from a previous one),
        // so record its span — the closing delimiter runs from i to i + run.
        if (multilineStart !== null) {
          multilineSpans.push({ start: multilineStart, end: i + run });
          multilineStart = null;
        }
      }
      i += Math.max(run, 1);
      continue;
    }
    if (multiline === 'basic') {
      if (c === '\\') {
        const next = consumeBasicStringEscape(line, i, true);
        if (next === null) malformed = true;
        i = next === null ? i + 1 : next;
        continue;
      }
      let run = 0;
      while (line[i + run] === '"') run += 1;
      if (run >= 3) {
        multiline = null;
        // The string opened on THIS line (not inherited from a previous one),
        // so record its span — the closing delimiter runs from i to i + run.
        if (multilineStart !== null) {
          multilineSpans.push({ start: multilineStart, end: i + run });
          multilineStart = null;
        }
      }
      i += Math.max(run, 1);
      continue;
    }
    if (c === '#') {
      return {
        code: line.slice(0, i),
        multilineOpen: multiline,
        stack,
        malformed,
        stringSpans,
        multilineSpans,
      };
    }
    if (c === '"' && line.startsWith('"""', i)) {
      multiline = 'basic';
      multilineStart = i;
      i += 3;
      continue;
    }
    if (c === "'" && line.startsWith("'''", i)) {
      multiline = 'literal';
      multilineStart = i;
      i += 3;
      continue;
    }
    if (c === '[') stack.push(']');
    else if (c === '{') stack.push('}');
    else if (c === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== ']') malformed = true;
      else stack.pop();
    } else if (c === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '}') malformed = true;
      else stack.pop();
    } else if (c === '"') {
      quote = 'basic';
      stringStart = i;
    } else if (c === "'") {
      quote = 'literal';
      stringStart = i;
    }
    i += 1;
  }
  // TOML single-line strings (basic and literal) can never span a line: a
  // quote still open at the end of the line — including a basic string whose
  // closing quote was escaped away by a trailing backslash (`i += 2` stepped
  // past the last character) — is a lexical error, not state to carry into
  // the next line. Carrying it would let a later fake-looking
  // `[mcp_servers.triss]` line be processed as a real header and the
  // migration rewrite a syntactically broken config, so the line is
  // malformed. A multi-line string open at EOL is NOT an error (that state is
  // carried via `multilineOpen`); the single-line `quote` is only ever set
  // outside multi-line strings, so this check never fires for valid triple-
  // quoted strings, quoted headers, or `#`/brackets inside closed strings.
  if (quote !== null) malformed = true;
  // A multi-line string that OPENED on this line and is still open at EOL
  // spans from its opener to the end of the line: every byte after the opener
  // is string content, so a caller text-scanning the line must skip matches
  // that overlap it (the cross-line case — the string closes on a later
  // line, which starts inside it and is skipped wholesale via `inMultiline`).
  if (multilineStart !== null) {
    multilineSpans.push({ start: multilineStart, end: line.length });
  }
  return {
    code: line.slice(0, i),
    multilineOpen: multiline,
    stack,
    malformed,
    stringSpans,
    multilineSpans,
  };
}

// Classify every line of the file. Returns:
//   { malformed, reason, lines: [{ header, inMultiline, startedInContainer, strings, multilineSpans }] }
// `header` is the parsed table header (null for non-header lines); a line
// that starts inside a multi-line string never carries a header and is marked
// with `inMultiline`; a line that starts inside an open square/curly
// container is VALUE content (array elements, inline-table bodies) and is
// marked with `startedInContainer` — such a line is never a header and never
// a key assignment of the current table, so key-hit scans skip it.
// `strings` is the list of index spans (inclusive start, exclusive end into
// the raw line) of every complete SINGLE-LINE basic/literal string on the
// line; callers that text-scan a line for a key assignment must skip any
// match that overlaps one of these spans — text inside a string is content,
// never a key.
// `multilineSpans` is the list of index spans of every MULTI-LINE
// basic/literal string that OPENS on the line: a same-line open/close string
// (`note = """text"""`, including one inside a same-line container such as
// `values = ["""a""", "b"]`) spans from its opener to its closer, and a
// string left open at EOL spans from its opener to the end of the line.
// Matches that overlap these spans are string content too — a line that
// merely STARTS inside a multi-line string is already skipped wholesale via
// `inMultiline`, so only strings that open on the line itself need a span.
// `malformed` is set when the file cannot be trusted:
// an unterminated multi-line string, an open container at EOF, a mismatched
// or stray closing delimiter, an invalid escape in a basic string (single- or
// multi-line; see codeBeforeComment), a single-line string left open at end
// of line (TOML single-line strings can never span a newline), or a
// header-like line (starting with `[` at statement depth zero) that does not
// parse.
// `reason` names the FIRST such defect (null when the file is well-formed),
// for clear error messages on the install/status/uninstall public paths.
export function scanToml(lines) {
  const out = { malformed: false, reason: null, lines: [] };
  const fail = (reason) => {
    out.malformed = true;
    if (!out.reason) out.reason = reason;
  };
  let multiline = null; // null | 'basic' | 'literal'
  let stack = []; // expected closers for open square/curly containers
  for (const line of lines) {
    const startedInMultiline = multiline !== null;
    // A line that starts inside an open array/container is VALUE content, not
    // a statement: its first characters are array elements / inline-table
    // keys, so even a line whose code begins with `[` (`[1, 2],` inside a
    // multi-line array of arrays) is never a table header and never marks the
    // file malformed.
    const startedInContainer = stack.length > 0;
    const info = {
      header: null,
      inMultiline: startedInMultiline,
      startedInContainer,
      strings: [],
      multilineSpans: [],
    };
    out.lines.push(info);
    // Every line — including one that starts inside a multi-line string — is
    // scanned by the same whole-line lexer. A close in the middle of the line
    // (`""",`) hands the remainder back to normal lexing, so array
    // punctuation, further strings, and comments after the close are legal;
    // only the final multiline state and the container stack carry over to
    // the next line. A mismatched or stray closer marks the file malformed —
    // the scan keeps classifying the remaining lines, but `malformed` stays
    // set so no caller trusts any of the output.
    const {
      code,
      multilineOpen,
      stack: endStack,
      malformed,
      stringSpans,
      multilineSpans,
    } = codeBeforeComment(line, multiline, stack);
    if (malformed) {
      fail(
        'a mismatched or stray closing delimiter, an invalid basic-string escape, or a single-line string left open at end of line',
      );
    }
    info.strings = stringSpans;
    info.multilineSpans = multilineSpans;
    multiline = multilineOpen;
    stack = endStack;
    // A line that starts inside a multi-line string can never be a table
    // header — its first characters are string content, so any `[` on it is
    // array/value punctuation, never a section boundary.
    if (startedInMultiline) continue;
    const trimmed = code.trimStart();
    if (!trimmed) continue; // blank or comment-only
    if (!startedInContainer && trimmed.startsWith('[')) {
      const header = parseHeaderLine(trimmed);
      if (!header) {
        fail('a line starting with `[` does not parse as a valid TOML table header');
        continue;
      }
      info.header = header;
      continue;
    }
    // Value / key line — a multi-line string that is still open at the end of
    // the line carries over to the next line (via multilineOpen). A string
    // that opened AND closed on this line leaves no state.
  }
  if (multiline) fail('an unterminated multi-line string at end of file');
  if (stack.length > 0) fail('an array or inline table is still open at end of file');
  return out;
}

// Locate the Triss block (header line index inclusive, end exclusive).
//
// `semantic` selects which root starts a block:
//   - false (the automatic legacy-timeout migration): ONLY the exact bare
//     single-bracket root `[mcp_servers.triss]` that triss itself generated —
//     all key parts unquoted. Quoted headers (even ["mcp_servers"."triss"],
//     which TOML treats as the SAME table) and array-of-tables headers are
//     different lexical forms and never start a migration block; any such
//     header also TERMINATES the block. The migration is narrow about WHAT it
//     walks and rewrites, but migrateCodexToolTimeout still counts every
//     semantic spelling when deciding ambiguity (see its doc comment) — this
//     function only picks the block start.
//   - true (install / status / uninstall): ANY single-bracket root whose key
//     parts name mcp_servers / triss, quoted or bare — ["mcp_servers"."triss"]
//     and ["mcp_servers".triss] (mixed quoting) are the same table as the
//     generated bare form, so the installer updates/replaces them without
//     creating a duplicate, status reports them, and uninstall removes them.
// The single-component ["mcp_servers.triss"] — a quoted key whose LITERAL
// name contains a dot — is a completely different table in both modes and
// always TERMINATES the block, so a following user table is never absorbed,
// removed, or reported as part of it. Triss sub-tables
// ([mcp_servers.triss.env], ["mcp_servers"."triss"."env"]) stay inside the
// block; in migration mode a quoted sub-table header still terminates it
// (the migration only ever walks the exact bare block). A semantic
// array-of-tables header ([[mcp_servers.triss]], see findTrissAotRoots)
// never starts a block and always TERMINATES one — its array shape cannot
// hold a regular table. A malformed file yields no block (callers treat it
// as absent — except the install/status/uninstall public paths, which throw
// first; see readCodexSnapshot).
//
// findTrissRoots returns EVERY single-bracket root header line (not just the
// first) under the given semantic mode, so callers can distinguish "one root"
// from "several equivalent spellings of the same table" — the latter is a
// duplicate-table declaration and fails closed (see singleSemanticTrissBlock
// and migrateCodexToolTimeout's ambiguity check).
function findTrissRoots(lines, scan, semantic) {
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    const h = scan.lines[i]?.header;
    if (h && !h.isArray && isTrissRoot(h.parts) && (semantic || !h.quoted)) {
      roots.push(i);
    }
  }
  return roots;
}

// A semantic ARRAY-OF-TABLES root: [[mcp_servers.triss]] — and its quoted,
// mixed, or escape-decoded two-component spellings ([["mcp_servers"."triss"]],
// [["mcp_servers".triss]], [["mcp\u005Fservers"."triss"]]) — declares an
// ARRAY of tables at the same dotted path the Triss root table occupies.
// TOML forbids a table and an array of tables from sharing a path, so an AoT
// root can never be a regular Triss block: install/status/uninstall fail
// closed on it and the migration never rewrites it. The single-component
// [["mcp_servers.triss"]] — one key whose literal name contains a dot — is a
// completely different array (isTrissRoot requires exactly two components)
// and is never counted.
function findTrissAotRoots(lines, scan) {
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    const h = scan.lines[i]?.header;
    if (h && h.isArray && isTrissRoot(h.parts)) roots.push(i);
  }
  return roots;
}

// The block a single root at line `start` spans: end is the first later line
// whose header does not continue the Triss root table (see findTrissBlock's
// doc comment for the exact boundary rules), with trailing blank lines
// trimmed from inside the block.
function trissBlockAt(lines, scan, start, semantic) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = scan.lines[i]?.header;
    // A header only continues the block when it is a sub-table OF the Triss
    // root. Quoted non-Triss headers, the single-component
    // ["mcp_servers.triss"] collision table, array-of-tables headers, and any
    // other section all terminate the block. In migration mode a quoted
    // sub-table header also terminates — the migration only ever rewrites the
    // exact bare block triss generated.
    if (h && (h.isArray || (!semantic && h.quoted) || !isTrissSection(h.parts))) {
      end = i;
      break;
    }
  }
  // Trim trailing blank lines from inside the block.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, end };
}

function findTrissBlock(lines, scan = scanToml(lines), { semantic = false } = {}) {
  if (scan.malformed) return null;
  const roots = findTrissRoots(lines, scan, semantic);
  if (roots.length === 0) return null;
  return trissBlockAt(lines, scan, roots[0], semantic);
}

// Public-path (install/status/uninstall) block location: exactly ONE
// semantic Triss root is allowed. More than one — any combination of the
// bare, quoted, mixed, or escape-decoded equivalent spellings of the
// two-component mcp_servers / triss key — declares the same table twice,
// which TOML forbids. No one block can be chosen over the others, so the
// operation FAILS CLOSED (the caller propagates the error and preserves the
// bytes) instead of silently picking one. A semantic ARRAY-OF-TABLES header
// ([[mcp_servers.triss]] and its quoted/mixed/escaped two-component forms,
// see findTrissAotRoots) occupies the same path with an incompatible array
// shape: whether it stands alone or coexists with a regular semantic root,
// the operation FAILS CLOSED rather than appending, reporting, or removing
// a regular table next to (or instead of) an array of tables. The distinct
// single-component ["mcp_servers.triss"] and [["mcp_servers.triss"]] tables
// are different tables and never count toward either total (see isTrissRoot),
// so a generated block plus such user tables is still a single unambiguous
// root.
function singleSemanticTrissBlock(lines, scan) {
  const roots = findTrissRoots(lines, scan, true);
  const aotRoots = findTrissAotRoots(lines, scan);
  if (aotRoots.length > 0) {
    throw new Error(
      'config.toml declares [[mcp_servers.triss]] as an array of tables ' +
        `(${aotRoots.length} array-of-tables headers) in place of the Triss ` +
        'table; refusing to use it',
    );
  }
  if (roots.length > 1) {
    throw new Error(
      'config.toml declares the Triss [mcp_servers.triss] table more than once ' +
        `(${roots.length} root headers); refusing to use it`,
    );
  }
  return roots.length === 1 ? trissBlockAt(lines, scan, roots[0], true) : null;
}

function tomlString(s) {
  return (
    '"' +
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  );
}

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function renderTrissToml(opts) {
  const command = opts.command || SERVER_NAME;
  const args = opts.args || ['mcp', 'serve'];
  const startup =
    opts.startupTimeoutSec ?? CODEX_STARTUP_TIMEOUT_SEC;
  const toolTimeout = opts.toolTimeoutSec ?? CODEX_TOOL_TIMEOUT_SEC;
  // Codex configs are global only — pinning TRISS_PROJECT_ROOT here would
  // sandbox every Codex session to one fixed directory. Same reasoning as
  // claudeEntry(): rely on launch-time cwd for the sandbox root.
  const env = { ...(opts.env || {}) };

  const lines = [];
  lines.push('[mcp_servers.triss]');
  lines.push(`command = ${tomlString(command)}`);
  lines.push(`args = [${args.map((a) => tomlString(a)).join(', ')}]`);
  if (Number.isFinite(startup)) lines.push(`startup_timeout_sec = ${startup}`);
  if (Number.isFinite(toolTimeout)) lines.push(`tool_timeout_sec = ${toolTimeout}`);

  if (Object.keys(env).length) {
    lines.push('');
    lines.push('[mcp_servers.triss.env]');
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// Pull `TRISS_PROJECT_ROOT = "…"` out of the existing Codex block so we can
// tell the user when an install drops a stale pin. Best-effort string scan;
// we don't fully parse TOML. Operates on the SEMANTIC Triss block (a quoted
// or mixed two-component root counts, see findTrissBlock) and reuses the
// scanner's per-line metadata instead of ad-hoc regex context: lines that
// START inside a multi-line string (`inMultiline`) or inside an open
// square/curly container (`startedInContainer`) are VALUE content, never key
// assignments of this table, and a match that overlaps any SINGLE-LINE
// string span on its line (`strings`) is string content too — so
// `note = 'TRISS_PROJECT_ROOT = "/x"'` never surfaces a spurious stale pin,
// while a real `TRISS_PROJECT_ROOT = "…"` key outside every string is still
// detected. A match that overlaps a MULTI-LINE string span that OPENS on the
// line (`multilineSpans`) is string content too: a multi-line basic/literal
// string can open mid-line — `note = """TRISS_PROJECT_ROOT = "/x" """`
// (opening and closing on the same line, even inside a same-line container
// like `values = ["""…"""]`), or opening mid-line and closing on a LATER
// line — and every byte after the opener up to the closer (or end of line)
// belongs to the string, so marker text there is never a real key.
function previousCodexProjectRoot(content, scan = scanToml(content.split('\n'))) {
  if (!content) return null;
  const lines = content.split('\n');
  const block = findTrissBlock(lines, scan, { semantic: true });
  if (!block) return null;
  for (let i = block.start; i < block.end; i++) {
    if (scan.lines[i]?.inMultiline) continue;
    if (scan.lines[i]?.startedInContainer) continue;
    const strings = scan.lines[i]?.strings || [];
    const multilineSpans = scan.lines[i]?.multilineSpans || [];
    for (const m of lines[i].matchAll(/TRISS_PROJECT_ROOT\s*=\s*"([^"\n]*)"/g)) {
      // Only the KEY part of the assignment — everything before the value's
      // opening quote — must lie outside every single-line string AND every
      // multi-line string that opens on the line. The whole match can never
      // be the test: a REAL `TRISS_PROJECT_ROOT = "…"` line always ends
      // inside its own quoted value, while a decoy like
      // `note = 'TRISS_PROJECT_ROOT = "/x"'` or
      // `note = """TRISS_PROJECT_ROOT = "/x" """` has the KEY text itself
      // inside the surrounding string.
      const keyStart = m.index;
      const keyEnd = m.index + m[0].indexOf('"');
      const keyInsideString =
        strings.some((s) => keyStart < s.end && keyEnd > s.start) ||
        multilineSpans.some((s) => keyStart < s.end && keyEnd > s.start);
      if (!keyInsideString) return m[1];
    }
  }
  return null;
}

// Drop the existing Triss block (and the blank line that separated it from
// surrounding content), returning the cleaned TOML. Operates on the SEMANTIC
// Triss block so a quoted/mixed two-component root is replaced/removed like
// the generated bare form (see findTrissBlock).
function stripTrissBlock(content, scan = scanToml(content.split('\n'))) {
  if (!content) return '';
  const lines = content.split('\n');
  const block = findTrissBlock(lines, scan, { semantic: true });
  if (!block) return content;
  let from = block.start;
  // Pull in the blank line that precedes our block as part of the deletion.
  if (from > 0 && lines[from - 1].trim() === '') from -= 1;
  const before = lines.slice(0, from).join('\n');
  const after = lines.slice(block.end).join('\n');
  if (!before) return after.replace(/^\n+/, '');
  if (!after.trim()) return before.endsWith('\n') ? before : before + '\n';
  const sep = before.endsWith('\n') ? '' : '\n';
  return before + sep + after.replace(/^\n+/, '\n');
}

// One validated read of the Codex config: the identity (entry kind, resolved
// real target, target inode/mode) and the content are captured TOGETHER and
// re-validated across the read by snapshotCodexConfig, and the returned
// content is lexically scanned. Returns { snapshot, content, scan } for an
// existing entry, or { missing: true } when the path has no entry at all.
// The SAME snapshot is what atomicReplaceCodexConfig later consumes as its
// CAS precondition, so nothing can change between the validated read and the
// atomic write without failing closed.
//
// A config that CHANGES while its content is being read THROWS (fail closed):
// the bytes were never validated against a stable identity, so they must not
// be analyzed, reported, or rewritten. A lexically malformed config THROWS a
// clear error instead of being treated as absent — mirroring readJson's
// malformed-JSON behavior above: install must never append a duplicate block
// next to unparseable bytes, status must not silently report "not
// registered", and uninstall must not silently no-op. A broken symlink (the
// entry exists but does not resolve to a readable regular file) also THROWS —
// its target bytes cannot be validated. No code path here ever modifies the
// file once the read or scan has failed. The caller still owns the decision
// for a MISSING file (each operation returns its own absent result).
function readCodexSnapshot(path, readFile = (p) => readFileSync(p, 'utf8')) {
  let snapshot;
  try {
    snapshot = snapshotCodexConfig(path, readFile);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // A genuinely absent entry vs a broken symlink: lstat is the entry-level
      // lookup that does NOT follow the link.
      let entryMissing;
      try {
        lstatSync(path);
        entryMissing = false;
      } catch (lstatErr) {
        if (lstatErr?.code === 'ENOENT') entryMissing = true;
        else throw lstatErr;
      }
      if (entryMissing) return { missing: true };
      throw new Error(
        `${path} is a broken symlink or otherwise unresolvable; refusing to use it`,
        { cause: err },
      );
    }
    if (err instanceof CodexConfigChangedError) {
      throw new Error(
        `${path}: destination changed while its content was being read; refusing to use it`,
        { cause: err },
      );
    }
    throw err;
  }
  const content = snapshot.original;
  const scan = scanToml(content.split('\n'));
  if (scan.malformed) {
    throw new Error(
      `${path} is not lexically valid TOML${scan.reason ? ` (${scan.reason})` : ''}; ` +
        'refusing to use it',
    );
  }
  return { snapshot, content, scan };
}

// Validated snapshot for a NOT-YET-EXISTING Codex config, used as the CAS
// precondition of the atomic no-clobber create. The canonical target path is
// resolved from the nearest existing ancestor (install has just created the
// .codex directory), so the atomicReplace precondition can verify the
// destination is STILL missing at the SAME canonical target before the
// hard-link install — a file that appeared meanwhile is never overwritten.
function missingCodexSnapshot(path) {
  return {
    destination: path,
    targetPath: canonicalTargetPath(path),
    symlink: false,
    identity: null,
    realIdentity: null,
    destinationIdentity: null,
    targetIdentity: null,
    original: null,
    mode: null,
    applyPrecondition: true,
  };
}

// Atomic replacement of the Codex config, delegating to the repository's
// atomicReplace (src/marker-transaction.js): the new bytes are written to a
// temp file in the target's own directory, fsynced, then renamed over the
// target (atomic on the same filesystem, so a concurrent reader never sees a
// torn file). Failure cleanup, mode preservation, and no-clobber checks all
// live in that shared helper. The migration only ever rewrites a config that
// already exists, so the path is first resolved through realpathSync: if
// ~/.codex/config.toml is a symlink, the atomic rename replaces the file the
// symlink points to and the symlink itself stays intact. Mode is preserved
// from the existing file via the 0o7777 mask.
//
// CAS: the wrapper snapshots the existing destination (path, resolved target,
// symlink flag, entry and real-target identities as BigInts, mode) and hands
// it to atomicReplace as its `expected` precondition along with
// `applyPrecondition`. The original content is the caller's expectedContent —
// for the migration that is the config bytes read during its initial analysis,
// so the atomic check fails closed if the file changed after the migration's
// own optimistic re-read but while the temp file was being written. That late
// race surfaces as a thrown precondition error (caught and warned by
// runMcpServe), distinct from the migration's earlier status-conflict result.
// The narrow injected options (write / rename / unlink) are forwarded for
// deterministic failure tests.
//
// The migration passes the exact validated snapshot it captured before
// analysis (and re-validated right before the write) via `expectedSnapshot`;
// when present, that snapshot — never a fresh one taken after the optimistic
// re-read — is the CAS precondition, so a symlink retarget or inode swap that
// lands after the re-read still fails closed. Callers without a snapshot fall
// back to snapshotting here at write time.
export function atomicReplaceCodexConfig(path, content, options = {}) {
  const { expectedContent, expectedSnapshot, ...rest } = options;
  const expected = expectedSnapshot
    ?? snapshotCodexConfig(path, (p) => expectedContent ?? readFileSync(p));
  return atomicReplace(expected.targetPath, content, expected.mode, { ...rest, expected });
}

// Thrown when the destination changed between the identity capture and the
// post-read recapture — i.e. while the config content was being read. Callers
// (migrateCodexToolTimeout) map it to a `conflict` status: the bytes were
// never validated against the current identity, so they must not be analyzed
// or written.
class CodexConfigChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexConfigChangedError';
    this.code = 'TRISS_CONFIG_CHANGED';
  }
}

// Capture the validated identity of the Codex config AND its content as one
// validated snapshot. The snapshot owns the injected read (`readFile`,
// defaulting to the real fs read): it is called with the RESOLVED real target
// path — never with the symlink path — so a symlink retarget cannot redirect
// the read to a file whose identity was never validated. The identity
// (directory entry kind + inode via lstat, resolved real target path, and the
// target's inode/mode via stat) is captured BEFORE the read and recaptured
// AFTER it; any change across the read throws a CodexConfigChangedError
// instead of returning a snapshot whose bytes came from an unvalidated path.
// The content returned by the validated read becomes the snapshot's
// `original`, so callers analyze and atomically write exactly the bytes that
// were validated.
function snapshotCodexConfig(path, readFile = (p) => readFileSync(p, 'utf8')) {
  const capture = () => {
    const entry = lstatSync(path, { bigint: true });
    const targetPath = realpathSync(path);
    let info = entry;
    if (entry.isSymbolicLink()) {
      info = statSync(targetPath, { bigint: true });
    }
    return { entry, targetPath, info };
  };

  const before = capture();
  const content = readFile(before.targetPath);
  const after = capture();

  if (
    before.entry.isSymbolicLink() !== after.entry.isSymbolicLink()
    || before.entry.dev !== after.entry.dev
    || before.entry.ino !== after.entry.ino
    || before.targetPath !== after.targetPath
    || before.info.dev !== after.info.dev
    || before.info.ino !== after.info.ino
    || (Number(before.info.mode) & 0o7777) !== (Number(after.info.mode) & 0o7777)
  ) {
    throw new CodexConfigChangedError(
      `${path}: destination changed while its content was being read; refusing to use it`,
    );
  }

  const entry = after.entry;
  const info = after.info;
  const identity = { dev: entry.dev, ino: entry.ino };
  const realIdentity = { dev: info.dev, ino: info.ino };
  return {
    destination: path,
    targetPath: after.targetPath,
    symlink: entry.isSymbolicLink(),
    identity,
    realIdentity,
    destinationIdentity: identity,
    targetIdentity: realIdentity,
    original: content,
    mode: Number(info.mode) & 0o7777,
    applyPrecondition: true,
  };
}

// The pre-write snapshot must match the pre-analysis snapshot on every
// identity, path, mode, and content field — identical bytes alone are not
// enough (a symlink retargeted to a same-content target must still fail).
function sameCodexSnapshot(a, b) {
  return a.symlink === b.symlink
    && a.targetPath === b.targetPath
    && a.mode === b.mode
    && a.identity.dev === b.identity.dev
    && a.identity.ino === b.identity.ino
    && a.realIdentity.dev === b.realIdentity.dev
    && a.realIdentity.ino === b.realIdentity.ino
    && a.original === b.original;
}

function installCodex(opts) {
  const path = configPath('global', 'codex');
  mkdirSync(dirname(path), { recursive: true });
  // The existing config is read AND scanned from ONE validated snapshot
  // (readCodexSnapshot / snapshotCodexConfig) — the same snapshot becomes the
  // atomicReplace CAS precondition, so any change to the destination — content,
  // symlink target or path, inode, mode — between analysis and the atomic
  // rename fails closed instead of clobbering a concurrent writer. A lexically
  // malformed existing config THROWS (readCodexSnapshot) — install never
  // treats it as absent and never appends a duplicate block next to
  // unparseable bytes. A MISSING file installs through the atomic no-clobber
  // create (hard-link) path: a concurrently-appearing file is never
  // overwritten, and readers only ever see the complete new inode.
  const state = readCodexSnapshot(path, opts.readFile);
  let snapshot;
  let had = false;
  let oldRoot = null;
  let next;
  if (state.missing) {
    snapshot = missingCodexSnapshot(path);
    next = renderTrissToml(opts);
  } else {
    const { snapshot: snap, content: before, scan } = state;
    snapshot = snap;
    const lines = before.split('\n');
    // More than one semantic Triss root (bare/quoted/mixed/escaped
    // equivalents) declares the same table twice — TOML forbids that, and no
    // block can be chosen over another: fail closed, bytes preserved.
    had = !!singleSemanticTrissBlock(lines, scan);
    oldRoot = previousCodexProjectRoot(before, scan);
    const stripped = stripTrissBlock(before, scan);
    const block = renderTrissToml(opts);
    if (!stripped.trim()) {
      next = block;
    } else {
      let prefix = stripped;
      if (!prefix.endsWith('\n')) prefix += '\n';
      if (!prefix.endsWith('\n\n')) prefix += '\n';
      next = prefix + block;
    }
  }
  const atomicWrite = opts.atomicWrite || atomicReplaceCodexConfig;
  // Commit atomically. When the config exists, the rename replaces the file
  // the resolved target points to (a symlink stays intact) and the snapshot's
  // mode is preserved; when it does not exist yet, createOnly forces the
  // no-clobber hard-link create and a file that appeared in the meantime is
  // never overwritten. Both paths write the temp file in the target's own
  // directory, fsync it, and expose only the complete result.
  atomicWrite(path, next, { expectedSnapshot: snapshot, createOnly: state.missing });
  const result = { path, status: had ? 'updated' : 'added', target: 'codex' };
  // The new block intentionally never contains TRISS_PROJECT_ROOT, so any
  // previously-pinned value was just dropped — surface it for the CLI
  // wrapper to print a one-liner so the user knows the semantics changed.
  if (oldRoot) result.migratedFrom = oldRoot;
  return result;
}

function uninstallCodex(opts = {}) {
  const path = configPath('global', 'codex');
  // The read and scan come from ONE validated snapshot; the same snapshot is
  // the atomicReplace CAS precondition so a concurrent change (content,
  // symlink target/path, inode, mode) fails closed instead of being stripped
  // away. A lexically malformed config THROWS (readCodexSnapshot) instead of
  // being treated as absent; its bytes are never modified.
  const state = readCodexSnapshot(path, opts.readFile);
  if (state.missing) return { path, status: 'absent', target: 'codex' };
  const { snapshot, content, scan } = state;
  const lines = content.split('\n');
  // More than one semantic Triss root is a duplicate-table declaration —
  // fail closed, bytes preserved.
  if (!singleSemanticTrissBlock(lines, scan)) {
    return { path, status: 'absent', target: 'codex' };
  }
  const stripped = stripTrissBlock(content, scan);
  const atomicWrite = opts.atomicWrite || atomicReplaceCodexConfig;
  atomicWrite(path, stripped, { expectedSnapshot: snapshot });
  return { path, status: 'removed', target: 'codex' };
}

function statusCodex(opts = {}) {
  const path = configPath('global', 'codex');
  // Read-only, but the read must still come from ONE validated snapshot: a
  // config that changes while being read is reported as a hard error, never
  // as a torn/partial snapshot. A lexically malformed config THROWS
  // (readCodexSnapshot) instead of silently reporting "not registered".
  const state = readCodexSnapshot(path, opts.readFile);
  if (state.missing) return { path, present: false, target: 'codex' };
  const { content, scan } = state;
  const lines = content.split('\n');
  // More than one semantic Triss root is a duplicate-table declaration —
  // fail closed rather than reporting one of them.
  const block = singleSemanticTrissBlock(lines, scan);
  if (!block) return { path, present: false, target: 'codex' };
  const entry = lines.slice(block.start, block.end).join('\n').trim();
  return { path, present: true, entry, target: 'codex' };
}

// ─── Codex tool_timeout_sec migration ────────────────────────────────────────
//
// Older Triss installs wrote `tool_timeout_sec = 120` into the Codex block.
// Once the outer tool timeout was raised (5460s) to cover the SDK's retries,
// stale installs would let the host kill a long thinking review. Because the
// config file is user-owned, every distribution path (npm/pnpm/yarn/source/
// standalone) now runs this migration on the first `triss mcp serve` startup
// instead of asking users to re-run the installer.
//
// The migration is deliberately narrow: it reads only ~/.codex/config.toml
// (or an injected path), only touches the direct keys of the root
// [mcp_servers.triss] table, and only rewrites the value token of exactly one
// historical `tool_timeout_sec = 120` assignment. It operates ONLY on the
// exact bare root header triss generated. A quoted/mixed/escape-decoded
// two-component root such as ["mcp_servers"."triss"] names the SAME table in
// TOML and COUNTS toward the ambiguity total (so a bare root next to one is
// `ambiguous`), but a single such root is never rewritten ("absent") — the
// migration only ever touches the exact bare lexical form (the installer
// treats quoted roots semantically; see findTrissBlock's `semantic` mode). A
// semantic array-of-tables header ([[mcp_servers.triss]], see
// findTrissAotRoots) occupies the same path with an incompatible array shape
// and is never rewritten either. The scan is driven by a conservative
// line-based TOML lexer (no dependency): headers with trailing comments and
// quoted headers are recognized as boundaries,
// text that merely looks like a header or key inside a multi-line
// basic/literal string is never recognized, and lines that start inside an
// open square/curly container (`[1, 2],` on its own line in an array of
// arrays, inline-table bodies) are values — never headers and never key
// assignments of this table, so a container-interior line that looks like
// `tool_timeout_sec = 120` is neither counted nor rewritten. The scan stops
// at the next TOML section header — including a Triss sub-table such as
// [mcp_servers.triss.env], whose keys are environment variables, not host
// settings — so only the root-level key that the Codex host actually reads is
// ever rewritten. Everything else — spacing, inline comments, every byte
// outside that token — is preserved byte-for-byte.
// An exact root-level `120` is always treated as the historical value: it is
// indistinguishable from a deliberately custom `120`, and the requirement is
// that every legacy exact-120 install is migrated automatically, so there is
// no opt-out or exception. The value token must be the canonical decimal
// spelling — `0` or [1-9]\d* — so non-canonical spellings that
// Number()-normalize to 120 (`+120`, `0120`, `1_2_0`), non-integer values
// (`120.0`, `"120"`, `0x78`), and assignment lines carrying MULTIPLE
// adjacent value expressions/tokens (`120 120`, `120 = 120`) are treated as
// custom values the migration never touches. Values other than that exact
// `120`, duplicate keys, a missing block, and a missing file are all left
// untouched; the function never creates the config just to migrate it. A config that declares MORE
// than one semantic two-component Triss root — any mix of the bare, quoted,
// mixed, or escape-decoded equivalent spellings, which all name the same
// table in TOML — is `ambiguous`: TOML forbids redefining a table, so no
// block is chosen over another and every byte stays untouched. A semantic
// array-of-tables root that coexists with a regular root is the same
// redefinition conflict and is also `ambiguous`; an AoT-only config is
// `absent` (the narrow migration never rewrites an array of tables).
// Malformed or lexically ambiguous TOML (an unterminated multi-line string,
// an open container at EOF, a mismatched or stray closing delimiter, an
// invalid escape in a basic string — single- or multi-line, an
// unparseable header-like line, or a single-line string left open at end of
// line — TOML single-line strings can never span a newline) is reported as
// `malformed` and left byte-for-byte untouched rather than guessed at. The rewritten file is committed atomically
// (same-directory temp + rename, permissions preserved). The identity of the
// destination — symlink entry, resolved real target, target inode/mode — and
// its content are captured as ONE validated snapshot before analysis: the
// snapshot owns the injected read, reads through the resolved real target,
// and immediately recaptures the identity, so a retarget or inode swap that
// lands between validation and read (even during the very first read) reports
// `conflict`. The optimistic pre-write re-read must then match that snapshot
// on every one of those fields; identical bytes are not enough, so a symlink
// retargeted to a same-content sibling reports `conflict` and the file is
// left untouched rather than written to an unvalidated path. A change that
// lands after that re-read, while the atomic temp file is being written, is
// caught by the atomicReplace CAS precondition (which consumes the exact
// pre-analysis snapshot), throwing instead of returning a status; runMcpServe
// treats that late failure as best-effort.

// Matches a `tool_timeout_sec = <int>` assignment line, tolerating flexible
// whitespace (spaces or tabs) and an optional trailing comment — with or
// without a whitespace separator (`120 # cap` or `120#compact` both match) —
// while keeping the prefix (key + spacing) and suffix (trailing whitespace /
// comment / CR) intact for byte-exact reconstruction. Both LF and CRLF lines
// are accepted: the caller splits on `\n`, so a CRLF line still ends with a
// trailing `\r`. The comment pattern never consumes the carriage return — `.`
// does not match `\r` and the trailing `\s*` mops up the CR after the comment
// (or the whole CR when there is no comment) — so the CR lands inside the
// suffix capture and survives the rewrite. A comment glued to the value is
// accepted on purpose: the integer token is still exactly 120 and the suffix
// is preserved, so the migration rewrites the value and leaves the comment
// untouched. The value must be the CANONICAL decimal spelling triss itself
// writes — `0` or a digit 1-9 followed by digits, no sign, no leading zeros,
// no underscores (TOML 1.1 forbids leading zeros, and `+120` / `0120` /
// `1_2_0` are non-canonical spellings that must never be Number()-normalized
// into a rewrite). `120.0`, `"120"`, `0x78`, or any multi-token value
// (`120 120`, `120 = 120`) do not match and are treated as custom values.
const TOOL_TIMEOUT_LINE_RE = /^(\s*tool_timeout_sec\s*=\s*)(0|[1-9]\d*)(\s*(?:#.*)?\s*)$/;

export function migrateCodexToolTimeout(opts = {}) {
  const path = opts.path || configPath('global', 'codex');
  const from = opts.from ?? HISTORICAL_CODEX_TOOL_TIMEOUT_SEC;
  const to = opts.to ?? CODEX_TOOL_TIMEOUT_SEC;
  // Injectable seams for deterministic tests without touching a real config:
  // readFile supplies the config bytes (defaults to the real fs read) and is
  // also used for the optimistic concurrency re-read below; atomicWrite
  // commits the rewritten bytes (defaults to atomicReplaceCodexConfig, the
  // repository atomicReplace wrapper).
  const readFile = opts.readFile || ((p) => readFileSync(p, 'utf8'));
  const atomicWrite = opts.atomicWrite || atomicReplaceCodexConfig;
  const result = { path, target: 'codex' };

  if (!existsSync(path)) return { ...result, status: 'absent' };
  // Capture the validated identity — directory entry, resolved real target,
  // target inode and mode — TOGETHER with the content, as ONE validated
  // snapshot before analysis. The snapshot owns the injected read: it reads
  // through the resolved real target and immediately recaptures the identity,
  // so a symlink retarget or inode swap that lands between validation and
  // read (the first-read TOCTOU window) throws and maps to `conflict` instead
  // of analyzing bytes that were never validated. This exact snapshot is the
  // atomic CAS precondition later, so nothing can change between validation,
  // read, and write without being detected.
  let firstSnapshot;
  try {
    firstSnapshot = snapshotCodexConfig(path, readFile);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ...result, status: 'absent' };
    if (err instanceof CodexConfigChangedError) {
      return { ...result, status: 'conflict' };
    }
    throw err;
  }
  const initial = firstSnapshot.original;
  const lines = initial.split('\n');
  const scan = scanToml(lines);
  if (scan.malformed) return { ...result, status: 'malformed' };
  // The migration is narrow about WHAT it rewrites (only the exact bare root
  // triss generated) but strict about WHICH files are ambiguous: every
  // single-bracket spelling of the two-component mcp_servers / triss key —
  // bare, quoted, mixed, or escape-decoded — names the same table in TOML,
  // so MORE than one semantic root declares that table twice. TOML forbids
  // redefining a table and no block can be chosen over the others, so the
  // migration reports "ambiguous" and leaves every byte untouched. A single
  // quoted/mixed/escaped root is still ONE root, but the migration only ever
  // rewrites the exact bare form, so it is "absent" and never touched. A
  // semantic array-of-tables header ([[mcp_servers.triss]] and its quoted/
  // mixed/escaped two-component forms) occupies the same path with an
  // incompatible array shape: an AoT-only config is never rewritten
  // ("absent"), while an AoT that coexists with a regular root is a
  // redefinition conflict — "ambiguous", bytes preserved. The distinct
  // single-component ["mcp_servers.triss"] and [["mcp_servers.triss"]] tables
  // are different tables and never count either.
  const semanticRoots = findTrissRoots(lines, scan, true);
  const aotRoots = findTrissAotRoots(lines, scan);
  if (aotRoots.length > 0) {
    if (semanticRoots.length > 0) return { ...result, status: 'ambiguous' };
    return { ...result, status: 'absent' };
  }
  if (semanticRoots.length > 1) return { ...result, status: 'ambiguous' };
  const rootLine = semanticRoots.length === 1 ? semanticRoots[0] : null;
  if (rootLine === null) return { ...result, status: 'absent' };
  // A single quoted/mixed/escaped root is semantically the Triss table, but
  // the narrow migration never rewrites any non-bare lexical form.
  if (scan.lines[rootLine].header.quoted) return { ...result, status: 'absent' };
  const block = trissBlockAt(lines, scan, rootLine, false);
  if (!block) return { ...result, status: 'absent' };

  // Only direct keys of the root [mcp_servers.triss] table are Codex host
  // settings. Stop the scan at the next section header of any kind — Triss
  // sub-tables like [mcp_servers.triss.env], quoted headers such as
  // ["mcp_servers"."triss"."env"], and headers with trailing comments
  // included — so a tool_timeout_sec under the env sub-table (an environment
  // variable, not the host timeout) is never counted or rewritten. The key
  // test requires the bare key at the line start (after optional indentation),
  // so comments and unrelated keys (`tool_timeout_sec_extra`) are not counted,
  // and lines that are actually inside a multi-line string — or that START
  // inside an open square/curly container (array elements, inline-table
  // bodies, i.e. VALUE content, never key assignments of this table) — are
  // never scanned.
  let end = lines.length;
  for (let i = block.start + 1; i < lines.length; i++) {
    if (scan.lines[i].header) {
      end = i;
      break;
    }
  }
  const hits = [];
  for (let i = block.start; i < end; i++) {
    if (scan.lines[i].inMultiline) continue;
    if (scan.lines[i].startedInContainer) continue;
    if (/^\s*tool_timeout_sec\s*=/.test(lines[i])) {
      hits.push({ index: i, match: lines[i].match(TOOL_TIMEOUT_LINE_RE) });
    }
  }

  // Duplicate keys mean the intent is ambiguous — never rewrite.
  if (hits.length > 1) return { ...result, status: 'ambiguous' };
  // The root key is absent — the host default applies, nothing to migrate.
  if (hits.length === 0) return { ...result, status: 'absent' };

  const { index, match } = hits[0];
  // Key present but the value is not a plain integer (quoted string, float,
  // comment-adjacent token…) — treat as a custom value we must not touch.
  if (!match) return { ...result, status: 'custom' };
  const value = Number(match[2]);
  if (value === to) return { ...result, status: 'current' };
  if (value !== from) return { ...result, status: 'custom' };

  // Optimistic concurrency guard: the config is user-owned, so another process
  // may have rewritten it since our first read. Re-read immediately before the
  // write and revalidate the FULL identity snapshot — entry, resolved target,
  // target inode/mode, AND content. Identical bytes alone are not enough: a
  // symlink retargeted to a same-content sibling, an inode swap, or a chmod
  // must all report "conflict" rather than write to an unvalidated path. This
  // early guard returns a status result; the atomic write below additionally
  // revalidates the config during temp writing and throws a precondition error
  // if it changed in that later window (see atomicReplaceCodexConfig).
  let secondSnapshot;
  try {
    secondSnapshot = snapshotCodexConfig(path, readFile);
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof CodexConfigChangedError) {
      return { ...result, status: 'conflict' };
    }
    throw err;
  }
  if (!sameCodexSnapshot(firstSnapshot, secondSnapshot)) {
    return { ...result, status: 'conflict' };
  }

  // Exactly one historical value — rewrite only that value token, keeping the
  // line's whitespace and inline comment byte-for-byte, then commit atomically
  // (same-directory temp + rename, permissions preserved, temp cleaned up on
  // failure). expectedSnapshot is the exact snapshot captured before analysis
  // and re-validated above, so atomicReplaceCodexConfig consumes THAT snapshot
  // as its CAS precondition instead of taking a fresh one after the re-read —
  // a change that lands between the re-read and the final rename still fails
  // closed rather than clobbering a user edit.
  lines[index] = match[1] + String(to) + (match[3] || '');
  atomicWrite(path, lines.join('\n'), { expectedSnapshot: firstSnapshot });
  return { ...result, status: 'updated', from, to };
}

// ─── Public API: dispatch on opts.target ─────────────────────────────────────

function rejectLocalCodex(scope, target) {
  if (target === 'codex' && scope === 'local') {
    throw new Error(
      "Codex doesn't support project-local MCP config — use --global with --target codex",
    );
  }
}

export function installEntry(scope, opts = {}) {
  const target = normTarget(opts.target);
  rejectLocalCodex(scope, target);
  if (target === 'codex') return installCodex(opts);
  return installClaude(scope, opts);
}

export function uninstallEntry(scope, opts = {}) {
  const target = normTarget(opts.target);
  rejectLocalCodex(scope, target);
  if (target === 'codex') return uninstallCodex(opts);
  return uninstallClaude(scope);
}

export function showStatus(scope, opts = {}) {
  const target = normTarget(opts.target);
  rejectLocalCodex(scope, target);
  if (target === 'codex') return statusCodex(opts);
  return statusClaude(scope);
}
