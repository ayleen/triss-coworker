// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export const RESPONSE_FORMATS = ['text', 'evidence'];

export const EVIDENCE_SYSTEM_SUFFIX = [
  '',
  'When response format is evidence, answer using exactly this compact Markdown contract:',
  '',
  'Outcome: <one concise conclusion>',
  '',
  'Evidence:',
  '- <claim> | <result> | <exact source or method> | <confidence>',
  '',
  'Uncertainty:',
  '- none',
  '',
  'Decision required: none',
  '',
  'Do not invent commands, source locations, verification, or evidence. Use `none` explicitly when a section has no entries.',
].join('\n');

export function validateResponseFormat(value) {
  // Only an *omitted* value defaults to text. An explicit empty string was
  // passed on purpose (e.g. `--format ''`) and is a malformed request, so it
  // fails like any other unknown value instead of silently defaulting.
  if (value === undefined) return 'text';
  if (typeof value !== 'string' || !RESPONSE_FORMATS.includes(value)) {
    throw new Error(`Invalid response format "${String(value)}". Expected text or evidence.`);
  }
  return value;
}

export function withEvidenceInstructions(systemPrompt, format) {
  const validated = validateResponseFormat(format);
  if (validated !== 'evidence') return systemPrompt;
  return `${systemPrompt}${EVIDENCE_SYSTEM_SUFFIX}`;
}

export function emptyReviewResponse(format) {
  const validated = validateResponseFormat(format);
  if (validated === 'text') return '(no changes between branches — nothing to review)';
  return [
    'Outcome: No changes between branches; nothing to review.',
    '',
    'Evidence:',
    '- No diff was produced | clean comparison | selected review diff source | high',
    '',
    'Uncertainty:',
    '- none',
    '',
    'Decision required: none',
  ].join('\n');
}
