// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Dependency-free HTML-to-Markdown converter for the site's own built pages.
// It covers the element inventory this Astro site emits (headings, lists,
// paragraphs, links, code, emphasis, images) and degrades safely: any tag it
// does not know is stripped to its text content, so raw markup can never
// leak into an agent-facing mirror.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←",
  ge: "≥", le: "≤", middot: "·", laquo: "«", raquo: "»", copy: "©",
};

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

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "");
}

function inline(html, baseUrl) {
  let out = html
    .replace(/<img\s[^>]*>/gi, (tag) => {
      const alt = tag.match(/\balt="([^"]*)"/i)?.[1] ?? "";
      const src = tag.match(/\bsrc="([^"]*)"/i)?.[1];
      return src ? `![${alt}](${absolutize(src, baseUrl)})` : alt;
    })
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
      const label = stripTags(text).replace(/\s+/g, " ").trim();
      if (!label) return "";
      if (href.startsWith("#")) return label;
      return `[${label}](${absolutize(href, baseUrl)})`;
    })
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "_$1_")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<br\s*\/?>/gi, "\n");
  out = stripTags(out);
  return decodeEntities(out);
}

function listsToMarkdown(html, baseUrl, indent = "") {
  return html.replace(/<(ol|ul)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => {
    let index = 0;
    const items = [];
    const itemRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let item;
    while ((item = itemRe.exec(inner))) {
      index += 1;
      // Nested lists become indented sub-lines before inline cleanup.
      const content = listsToMarkdown(item[1], baseUrl, `${indent}  `);
      const marker = tag.toLowerCase() === "ol" ? `${index}. ` : "- ";
      const rendered = inline(content, baseUrl).trim().replace(/\n{3,}/g, "\n\n");
      items.push(indent + marker + rendered.replace(/\n/g, `\n${indent}  `));
    }
    return `\n${items.join("\n")}\n${indent}`;
  });
}

export function htmlToMarkdown(html, baseUrl) {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style|svg|button|select|input)\b[^>]*>[\s\S]*?<\/(?:script|style|svg|button|select|input)>/gi, "")
    .replace(/<(?:input|select)\b[^>]*\/?>/gi, "");

  // Fenced code blocks are protected from all later transforms.
  const blocks = [];
  body = body.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (m, code) => {
    blocks.push(decodeEntities(stripTags(code)).replace(/\n$/, ""));
    return `\uE000B${blocks.length - 1}\uE000`;
  });

  body = listsToMarkdown(body, baseUrl);

  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, level, text) => `\n\n${"#".repeat(Number(level))} ${inline(text, baseUrl).trim()}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, text) => {
      const quoted = inline(text, baseUrl).trim().split("\n").map((line) => `> ${line.trim()}`).join("\n");
      return `\n\n${quoted}\n\n`;
    })
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<\/(?:p|div|section|article|header|footer|figure|h[1-6]|blockquote|pre|main)>/gi, "\n\n")
    .replace(/<(?:p|div|section|article|figure|main)\b[^>]*>/gi, "\n\n");

  body = inline(body, baseUrl);

  body = body
    // \uE000 (Unicode private use area) placeholders never occur in real content.
    .replace(new RegExp("\\uE000B(\\d+)\\uE000", "g"), (m, index) => `\n\n\`\`\`\n${blocks[Number(index)]}\n\`\`\`\n\n`)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return `${body}\n`;
}

export function extractMain(html) {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : html;
}
