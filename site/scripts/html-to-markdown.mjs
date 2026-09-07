// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// HTML-to-Markdown converter for the site's own built pages. Build-time only.
//
// The document is parsed once with parse5 and rendered from the tree, so the
// failure modes of regex rewriting are gone by construction: text nodes are
// already entity-decoded by the parser (never re-stripped), decorative
// subtrees (controls, scripts) are dropped whole — void elements like <input>
// cannot swallow the text around them — and unknown elements fall through to
// their children instead of being deleted.

import { parse, serialize } from "parse5";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←",
  ge: "≥", le: "≤", middot: "·", laquo: "«", raquo: "»", copy: "©",
};

// Legacy helper kept for callers that inspect raw text; the AST pipeline
// itself relies on parse5's decoding.
export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function absolutize(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

// Decorative or interactive subtrees: dropped whole, never partially.
const DROPPED = new Set([
  "script", "style", "template", "noscript", "iframe", "canvas", "object", "embed",
  "svg", "math",
  "button", "select", "option", "datalist", "input", "textarea", "output",
]);

// `hidden`-attribute subtrees are not part of the rendered page, so they
// must not leak into the mirror either (JS-only controls, progress bars).
// Text nodes are never "dropped" — only whole elements are.
function dropped(node) {
  return isElement(node) && (DROPPED.has(node.tagName) || hasFlag(node, "hidden"));
}

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "details", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "tfoot", "thead", "tr", "ul",
]);

function attr(node, name) {
  return node.attrs.find((a) => a.name === name)?.value;
}

function hasFlag(node, name) {
  return attr(node, name) !== undefined;
}

function classNames(node) {
  return (attr(node, "class") || "").split(/\s+/).filter(Boolean);
}

function collapse(text) {
  return text.replace(/\s+/g, " ");
}

function isElement(node) {
  return node.nodeName !== undefined && node.tagName !== undefined;
}

function elementChildren(node) {
  return (node.childNodes || []).filter(isElement);
}

function textContent(node) {
  if (!isElement(node)) {
    return node.nodeName === "#comment" ? "" : node.value || "";
  }
  if (dropped(node)) return "";
  return (node.childNodes || []).map(textContent).join("");
}

function inlineCode(text) {
  const ticks = "`".repeat((text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0) + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${ticks}${padded}${ticks}`;
}

function renderImage(node, baseUrl) {
  const alt = attr(node, "alt") ?? "";
  const src = attr(node, "src");
  return src ? `![${alt}](${absolutize(src, baseUrl)})` : alt;
}

function renderLink(node, baseUrl, ctx) {
  const label = renderInlineNodes(node.childNodes, ctx).replace(/\s+/g, " ").trim();
  if (!label) return "";
  const href = attr(node, "href");
  if (!href || href.startsWith("#")) {
    // In-page anchors have no guaranteed Markdown heading IDs; link the
    // canonical HTML page instead of dropping the reference silently.
    return href ? `[${label}](${absolutize(href, baseUrl)})` : label;
  }
  return `[${label}](${absolutize(href, baseUrl)})`;
}

function renderInline(node, baseUrl, ctx) {
  switch (node.tagName) {
    case "br":
      return "\n";
    case "img":
      return renderImage(node, baseUrl);
    case "a":
      return renderLink(node, baseUrl, ctx);
    case "code":
      return inlineCode(textContent(node).replace(/\s+/g, " ").trim());
    case "strong":
    case "b":
      return `**${renderInlineNodes(node.childNodes, ctx).trim()}**`;
    case "em":
    case "i":
      return `_${renderInlineNodes(node.childNodes, ctx).trim()}_`;
    case "kbd":
    case "samp":
      return inlineCode(textContent(node).replace(/\s+/g, " ").trim());
    default:
      return renderInlineNodes(node.childNodes, ctx);
  }
}

// Inline runs keep source whitespace: spaces are only ever added where the
// site's own text nodes carry them, so emphasis in prose is never corrupted.
// CSS-gap layouts (CommandCard chips) instead opt into explicit separators
// via data-agent-flags / data-agent-meta markers.
function renderInlineNodes(nodes, ctx) {
  let out = "";
  for (const node of nodes) {
    if (node.nodeName === "#comment") continue;
    if (isElement(node)) {
      if (dropped(node)) continue;
      out += hasFlag(node, "data-agent-flags")
        ? renderAgentFlags(node)
        : hasFlag(node, "data-agent-meta")
          ? renderAgentMeta(node)
          : renderInline(node, ctx.baseUrl, ctx);
    } else {
      out += collapse(node.value || "");
    }
  }
  return out;
}

function renderAgentFlags(node) {
  return elementChildren(node)
    .map((child) => collapse(textContent(child)).trim())
    .filter(Boolean)
    .map(inlineCode)
    .join(" ");
}

function renderAgentMeta(node) {
  return elementChildren(node)
    .map((child) => collapse(textContent(child)).trim())
    .filter(Boolean)
    .join(" · ");
}

function renderList(node, baseUrl, depth, ctx) {
  const ordered = node.tagName === "ol";
  const items = elementChildren(node).filter((child) => child.tagName === "li");
  const start = Number.parseInt(attr(node, "start") ?? "1", 10) || 1;
  const lines = items.map((item, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const body = renderListItemContent(item, depth + 1, ctx);
    const indent = " ".repeat(marker.length);
    return marker + body.replace(/\n/g, `\n${indent}`);
  });
  return lines.filter((line) => line.trim()).map((line) => "  ".repeat(depth) + line).join("\n");
}

function renderListItemContent(item, depth, ctx) {
  // Blocks inside an item stack tightly; nested lists recurse with depth.
  const parts = [];
  let inlineRun = "";
  const flush = () => {
    const text = inlineRun.trim();
    inlineRun = "";
    if (text) parts.push(text);
  };
  for (const node of item.childNodes || []) {
    if (node.nodeName === "#comment") continue;
    if (isElement(node) && BLOCK.has(node.tagName) && node.tagName !== "li") {
      if (dropped(node)) continue;
      flush();
      const rendered = renderBlock(node, ctx.baseUrl, ctx).trim();
      if (rendered) parts.push(rendered);
    } else if (isElement(node) && (node.tagName === "ul" || node.tagName === "ol")) {
      flush();
      const nested = renderList(node, ctx.baseUrl, depth, ctx);
      if (nested) parts.push(nested);
    } else {
      inlineRun += dropped(node) ? "" : isElement(node) ? renderInline(node, ctx.baseUrl, ctx) : collapse(node.value || "");
    }
  }
  flush();
  return parts.join("\n");
}

// GFM table cells escape the backslash before the pipe, or a literal "\|"
// would turn into an escaped pipe.
function escapeCell(text) {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function renderTable(table, baseUrl, ctx) {
  const rows = [];
  const pushRow = (cells, header = false) => {
    const line = `| ${cells.map((cell) => escapeCell(renderInlineNodes(cell.childNodes, ctx))).join(" | ")} |`;
    rows.push(header ? { header: line } : line);
  };
  for (const section of elementChildren(table)) {
    if (section.tagName === "tr") {
      pushRow(elementChildren(section).filter((c) => ["td", "th"].includes(c.tagName)));
    } else if (["thead", "tbody", "tfoot"].includes(section.tagName)) {
      for (const row of elementChildren(section)) {
        if (row.tagName !== "tr") continue;
        pushRow(
          elementChildren(row).filter((c) => ["td", "th"].includes(c.tagName)),
          section.tagName === "thead",
        );
      }
    }
  }
  if (rows.length === 0) return "";
  // GFM requires a delimiter row after the header line; a <thead>-less
  // table promotes its first row so the output still parses as a table.
  const hasHeader = typeof rows[0] === "object";
  const header = hasHeader ? rows[0].header : null;
  const body = (hasHeader ? rows.slice(1) : rows).map((row) => (typeof row === "string" ? row : row.header));
  const columns = Math.max(...[header, ...body].filter(Boolean).map((line) => line.split("|").length - 2));
  const delimiter = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const out = [];
  if (header) {
    out.push(header, delimiter, ...body);
  } else if (body.length > 0) {
    out.push(body[0], delimiter, ...body.slice(1));
  }
  return out.join("\n");
}

// Grid "tables" built from styled divs (e.g. the cost tables) declare their
// column count with data-agent-cols; cells are direct element children.
function renderAgentTable(node, baseUrl, ctx) {
  const columns = Number.parseInt(attr(node, "data-agent-cols") ?? "0", 10);
  const cells = elementChildren(node);
  if (!columns || cells.length === 0 || cells.length % columns !== 0) {
    return renderContainer(node, baseUrl, ctx);
  }
  const cellText = (cell) => escapeCell(renderInlineNodes(cell.childNodes, ctx));
  const rows = [];
  for (let i = 0; i < cells.length; i += columns) {
    rows.push(Array.from({ length: columns }, (_, offset) => cellText(cells[i + offset])));
  }
  const [header, ...body] = rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function renderPre(node) {
  const code = textContent(node).replace(/\n$/, "");
  const fence = "```".repeat(code.includes("```") ? 2 : 1);
  return `${fence}\n${code}\n${fence}`;
}

function renderDetails(node, baseUrl, ctx) {
  const summary = elementChildren(node).find((child) => child.tagName === "summary");
  const heading = summary ? `**${renderInlineNodes(summary.childNodes, ctx).replace(/\s+/g, " ").trim()}**` : "";
  const body = renderContainer(node, baseUrl, ctx);
  return [heading, body].filter(Boolean).join("\n\n");
}

function renderBlock(node, baseUrl, ctx) {
  switch (node.tagName) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(node.tagName[1]);
      return `${"#".repeat(level)} ${renderInlineNodes(node.childNodes, ctx).replace(/\s+/g, " ").trim()}`;
    }
    case "p":
      return renderInlineNodes(node.childNodes, ctx).trim();
    case "pre":
      return renderPre(node);
    case "ul":
    case "ol":
      return renderList(node, baseUrl, 0, ctx);
    case "blockquote": {
      const quoted = renderContainer(node, baseUrl, ctx).trim();
      return quoted.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    }
    case "hr":
      return "---";
    case "table":
      return renderTable(node, baseUrl, ctx);
    case "details":
      return renderDetails(node, baseUrl, ctx);
    default:
      if (classNames(node).includes("cost-table")) return renderAgentTable(node, baseUrl, ctx);
      if (hasFlag(node, "data-agent-flags")) return renderAgentFlags(node);
      if (hasFlag(node, "data-agent-meta")) return renderAgentMeta(node);
      return renderContainer(node, baseUrl, ctx);
  }
}

// Block containers join block children with blank lines and keep inline runs
// (text, spans, links) flowing as paragraphs.
function renderContainer(node, baseUrl, ctx) {
  const parts = [];
  let inlineRun = "";
  const flush = () => {
    const text = inlineRun.replace(/^\s+|\s+$/g, "");
    inlineRun = "";
    if (text) parts.push(text);
  };
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#comment") continue;
    if (isElement(child) && BLOCK.has(child.tagName)) {
      if (dropped(child)) continue;
      flush();
      const rendered = renderBlock(child, baseUrl, ctx).trim();
      if (rendered) parts.push(rendered);
    } else {
      inlineRun += dropped(child) ? "" : isElement(child) ? renderInline(child, baseUrl, ctx) : collapse(child.value || "");
    }
  }
  flush();
  return parts.join("\n\n");
}

export function htmlToMarkdown(html, baseUrl) {
  const document = parse(String(html));
  const body = findBody(document);
  const ctx = { baseUrl };
  return `${renderContainer(body, baseUrl, ctx).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function findBody(document) {
  const htmlNode = elementChildren(document).find((node) => node.tagName === "html") ?? document;
  return elementChildren(htmlNode).find((node) => node.tagName === "body") ?? htmlNode;
}

// Select the substantive content areas of a built page for the agent-facing
// mirror: explicit [data-agent-content] markers in document order (nested
// markers are absorbed by their ancestor), else the <main> element, else the
// whole body. Returns serialized HTML fragments.
export function selectAgentContent(html) {
  const document = parse(String(html));
  const body = findBody(document);
  const marked = [];
  const walk = (node, insideMarked) => {
    const markedHere = hasFlag(node, "data-agent-content");
    if (markedHere && !insideMarked) marked.push(node);
    for (const child of elementChildren(node)) walk(child, insideMarked || markedHere);
  };
  walk(body, false);
  if (marked.length > 0) return marked.map((node) => serialize(node));
  const main = (() => {
    let found;
    const findMain = (node) => {
      for (const child of elementChildren(node)) {
        if (child.tagName === "main") { found = child; return; }
        findMain(child);
        if (found) return;
      }
    };
    findMain(body);
    return found;
  })();
  return [serialize(main ?? body)];
}

// Legacy helper kept for compatibility with earlier callers.
export function extractMain(html) {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : html;
}
