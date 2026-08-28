// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

(function () {
'use strict';
const INTS = {
  jira: { cmd: 'triss jira', body: 'Search with JQL, read an issue with its comment history, then create, update, comment, or transition it.', env: 'ATLASSIAN_* (site, email, API token)', ops: 'search, issue, create, update, comments, transitions', lines: '$ triss jira search "project = ENG AND status = Open" \n    --question "what is blocked on us?"\n\n→ 3 of 24 issues wait on our review\n→ ENG-118 blocks the release' },
  confluence: { cmd: 'triss confluence', body: 'CQL search across spaces, read a page as text, and create or update pages. Useful when the spec is a wiki page.', env: 'ATLASSIAN_* (shared with Jira)', ops: 'search, page, create, update, spaces', lines: '$ triss confluence search \'space = ARCH AND title ~ "rate limit"\' \n    --question "what is the agreed policy?"\n\n→ 60 req/min per key, burst 100 (ARCH/412)' },
  linear: { cmd: 'triss linear', body: 'The widest surface of the five: issues, projects, initiatives, milestones, labels, states, attachments, and bulk updates.', env: 'LINEAR_API_KEY', ops: 'search, issue, create, update, comments, states, attachments, projects', lines: '$ triss linear search "Q3 platform" \n    --question "which issues have no owner?"\n\n→ 6 unassigned, 2 on the milestone' },
  github: { cmd: 'triss github', body: 'Search, read, create, update, and comment on issues. Pairs naturally with triss review <PR>.', env: 'GITHUB_TOKEN — or gh CLI', ops: 'search, issue, create, update, comments', lines: '$ triss github issue 812 \n    --question "has anyone reproduced this?"\n\n→ yes: two reports on Node 22, none on 24' },
  gitlab: { cmd: 'triss gitlab', body: 'The same five operations against a GitLab instance, self-hosted included.', env: 'GITLAB_TOKEN', ops: 'search, issue, create, update, comments', lines: '$ triss gitlab search "incident" \n    --question "anything still open?"\n\n→ 1 open: #204, waiting on infra' },
};
let active = 'jira';
function renderInt() {
  const d = INTS[active];
  document.getElementById('int-panel').innerHTML = "<div style='font-family:var(--font-mono); font-size:13px; color:var(--color-accent);'>" + d.cmd + "</div><p style='margin:10px 0 0; font-size:13.5px; line-height:1.6; color:var(--color-text-secondary);'>" + d.body + "</p><div style='margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;'><span style='font-family:var(--font-mono); font-size:11.5px; background:var(--color-bg-code); border:1px solid var(--color-border-subtle); padding:6px 10px; color:var(--color-text-muted);'>" + d.env + "</span><span style='font-family:var(--font-mono); font-size:11.5px; background:var(--color-bg-code); border:1px solid var(--color-border-subtle); padding:6px 10px; color:var(--color-text-muted);'>" + d.ops + "</span></div><pre style='margin-top:16px; background:#08090b; border:1px solid var(--color-border-subtle); padding:16px; font-family:var(--font-mono); font-size:12.5px; white-space:pre-wrap; color:var(--color-text-code);'>" + d.lines + "</pre>";
  document.querySelectorAll('.int-btn').forEach(b => {
    const on = b.getAttribute('data-int')===active;
    b.setAttribute('aria-pressed', String(on));
    b.style.background = on ? 'var(--color-bg-raised)' : 'transparent';
    b.style.color = on ? 'var(--color-accent)' : 'var(--color-text-muted)';
  });
}
document.querySelectorAll('.int-btn').forEach(b => b.addEventListener('click', () => { active = b.getAttribute('data-int'); renderInt(); }));
renderInt();
})();
