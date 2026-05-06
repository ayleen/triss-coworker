// Minimal Atlassian Document Format ↔ plain text bridge.
// We do not aim for full ADF fidelity — just enough that round-tripping
// description fields between humans, agents, and Jira is comprehensible.

export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');

  const { type, content, text, attrs } = node;
  const inner = content ? content.map(adfToText).join('') : '';

  switch (type) {
    case 'doc':
      return inner.trim() + '\n';
    case 'paragraph':
      return inner + '\n\n';
    case 'heading': {
      const level = attrs?.level ?? 1;
      return '#'.repeat(level) + ' ' + inner + '\n\n';
    }
    case 'bulletList':
      return content.map((c) => '- ' + adfToText(c).trim()).join('\n') + '\n\n';
    case 'orderedList':
      return content.map((c, i) => `${i + 1}. ` + adfToText(c).trim()).join('\n') + '\n\n';
    case 'listItem':
      return inner;
    case 'codeBlock': {
      const lang = attrs?.language ?? '';
      return '```' + lang + '\n' + inner + '\n```\n\n';
    }
    case 'blockquote':
      return inner
        .split('\n')
        .map((l) => (l ? '> ' + l : l))
        .join('\n') + '\n';
    case 'rule':
      return '\n---\n';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return '@' + (attrs?.text || attrs?.id || '');
    case 'inlineCard':
    case 'blockCard':
      return attrs?.url || '';
    case 'text': {
      let out = text ?? '';
      const marks = node.marks || [];
      for (const m of marks) {
        if (m.type === 'code') out = '`' + out + '`';
        else if (m.type === 'strong') out = '**' + out + '**';
        else if (m.type === 'em') out = '*' + out + '*';
        else if (m.type === 'link') out = `[${out}](${m.attrs?.href ?? ''})`;
      }
      return out;
    }
    default:
      return inner;
  }
}

export function textToAdf(text) {
  const blocks = String(text ?? '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (!blocks.length) {
    return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] };
  }
  const content = blocks.map((b) => paragraph(b));
  return { type: 'doc', version: 1, content };
}

function paragraph(s) {
  const lines = s.split('\n');
  const inline = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) inline.push({ type: 'text', text: lines[i] });
    if (i < lines.length - 1) inline.push({ type: 'hardBreak' });
  }
  return { type: 'paragraph', content: inline };
}
