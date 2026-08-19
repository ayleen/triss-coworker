const LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;

function withoutCode(source) {
  let fence = null;
  const visible = [];
  for (const line of source.split('\n')) {
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1] || null;
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      visible.push('');
      continue;
    }
    visible.push(fence ? '' : line);
  }
  return visible.join('\n').replace(/(`+)([\s\S]*?)\1/g, '');
}

export function extractMarkdownLinkTargets(source) {
  const targets = [];
  for (const match of withoutCode(source).matchAll(LINK_PATTERN)) {
    const raw = match[1];
    let target = raw.trim();
    if (target.startsWith('<')) {
      const end = target.indexOf('>');
      if (end === -1) throw new Error(`invalid angle-bracket link target: ${raw}`);
      target = target.slice(1, end);
    } else {
      target = target.split(/\s+/, 1)[0];
    }
    targets.push({ raw, target });
  }
  return targets;
}
