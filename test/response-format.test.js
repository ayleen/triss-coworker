// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import {
  emptyReviewResponse,
  validateResponseFormat,
  withEvidenceInstructions,
  EVIDENCE_SYSTEM_SUFFIX,
} from '../src/response-format.js';
import { runReviewCore } from '../src/mcp/review-core.js';
import {
  REVIEW_SYSTEM_PROMPT,
  reviewSystemPromptForFormat,
} from '../src/review-prompt.js';
import { runAskWithDeps } from '../src/commands/ask.js';
import { runReviewWithDeps } from '../src/commands/review.js';
import { askHandler, reviewHandler } from '../src/mcp/handlers.js';
import { handleToolRequest } from '../src/mcp/server.js';
import { createExecutionResult } from '../src/transports/result.js';

function executionDeps(text = 'ok', capture) {
  return {
    executeModelTask: async (request) => {
      capture?.(request);
      request.input.onText?.(text);
      return {
        resolved: { providerId: 'openai-compatible', publicModel: 'test' },
        result: createExecutionResult({
          text,
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 4 },
        }),
      };
    },
  };
}


test('response format defaults to text and rejects unknown values', () => {
  assert.equal(validateResponseFormat(undefined), 'text');
  assert.equal(validateResponseFormat('text'), 'text');
  assert.equal(validateResponseFormat('evidence'), 'evidence');
  assert.throws(() => validateResponseFormat('json'), /response format.*text.*evidence/i);
});

test('an explicit empty or null format is invalid; only undefined defaults to text', () => {
  assert.equal(validateResponseFormat(undefined), 'text');
  assert.throws(() => validateResponseFormat(null), /Invalid response format/);
  // `--format ''` was passed on purpose — an empty explicit value is a
  // malformed request, not a silent default, so it must fail like any other
  // unknown value instead of being coerced to text.
  assert.throws(() => validateResponseFormat(''), /Invalid response format/);
  assert.throws(() => validateResponseFormat(' '), /Invalid response format/);
  assert.throws(() => validateResponseFormat(['evidence']), /Invalid response format/);
  assert.throws(() => validateResponseFormat({ toString: () => 'text' }), /Invalid response format/);
});

test('MCP runtime boundary rejects non-string response_format before ask or review work', async () => {
  for (const name of ['triss_ask', 'triss_review']) {
    let modelWork = false;
    const handler = name === 'triss_ask'
      ? (args) => askHandler(args, {
        resolveModelRequest: () => { modelWork = true; return { provider: 'worker', model: 'test' }; },
      })
      : (args) => reviewHandler(args, {
        callModel: async () => { modelWork = true; return { content: 'bad', usageReport: '' }; },
      });
    const result = await handleToolRequest({
      params: {
        name,
        arguments: name === 'triss_ask'
          ? { paths: ['missing'], question: 'q', response_format: ['evidence'] }
          : { base: 'main', response_format: ['evidence'] },
      },
    }, {}, { findTool: async () => ({ handler }) });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid response format/);
    assert.equal(modelWork, false);
  }
});

test('clean reviews preserve text compatibility and return the full evidence contract', async () => {
  const text = emptyReviewResponse('text');
  assert.equal(text, '(no changes between branches — nothing to review)');
  const evidence = emptyReviewResponse('evidence');
  assert.match(evidence, /^Outcome:/);
  assert.match(evidence, /\nEvidence:\n/);
  assert.match(evidence, /\nUncertainty:\n/);
  assert.ok(evidence.endsWith('Decision required: none'));

  const originalOut = process.stdout.write;
  const output = [];
  process.stdout.write = (value) => { output.push(String(value)); return true; };
  try {
    const cli = await runReviewWithDeps(undefined, { base: 'main', format: 'evidence' }, {
      gitDiff: () => '',
      resolveModelRequest: () => { throw new Error('model must not run'); },
    });
    assert.equal(cli, evidence);
    assert.equal(output.join('').trimEnd(), evidence);

    output.length = 0;
    const textCli = await runReviewWithDeps(undefined, { base: 'main' }, {
      gitDiff: () => '',
      resolveModelRequest: () => { throw new Error('model must not run'); },
    });
    assert.equal(textCli, undefined, 'legacy text-mode callable return stays undefined');
    assert.equal(stripVTControlCharacters(output.join('')).trimEnd(), text);
  } finally {
    process.stdout.write = originalOut;
  }

  const mcp = await runReviewCore({
    base: 'main',
    responseFormat: 'evidence',
    gitDiffFn: () => '',
    callModel: async () => { throw new Error('model must not run'); },
  });
  assert.equal(mcp, evidence);
});

test('review token budgets reject malformed values before Git or model work', async () => {
  for (const maxTokens of ['abc', '1.5', '12junk', 0, -1]) {
    let gitRead = false;
    await assert.rejects(
      () => runReviewWithDeps(undefined, { base: 'main', maxTokens }, {
        gitDiff: () => { gitRead = true; return ''; },
      }),
      /max-tokens must be a positive integer/,
    );
    assert.equal(gitRead, false, String(maxTokens));

    await assert.rejects(
      () => reviewHandler({ base: 'main', max_tokens: maxTokens }),
      /max_tokens must be a positive integer/,
    );
  }
});

test('evidence instructions append to the effective system prompt', () => {
  const custom = 'Use our internal review policy.';
  assert.equal(withEvidenceInstructions(custom, 'text'), custom);
  const prompt = withEvidenceInstructions(custom, 'evidence');
  assert.ok(prompt.startsWith(custom));
  assert.ok(prompt.endsWith(EVIDENCE_SYSTEM_SUFFIX));
  assert.match(prompt, /Outcome:/);
  assert.match(prompt, /Evidence:/);
  assert.match(prompt, /Uncertainty:/);
  assert.match(prompt, /Decision required:/);
  assert.match(prompt, /do not invent/i);
});

test('review prompt helper is format-aware: text keeps the one-line clean rule, evidence requires the contract', () => {
  // Text mode must keep the exact one-line clean output rule untouched.
  const text = reviewSystemPromptForFormat('text');
  assert.equal(text, REVIEW_SYSTEM_PROMPT);
  assert.match(text, /No issues found/);
  assert.match(text, /in one line/);
  assert.doesNotMatch(text, /Outcome:/);

  // Evidence mode must drop the one-line clean rule and require the shared
  // Markdown contract with a clean-outcome direction, so the two output
  // instructions cannot contradict each other.
  const evidence = reviewSystemPromptForFormat('evidence');
  assert.doesNotMatch(evidence, /say "No issues found\." in one line/);
  assert.match(evidence, /Outcome: No issues found\./);
  assert.match(evidence, /Outcome:/);
  assert.match(evidence, /Evidence:/);
  assert.match(evidence, /Uncertainty:/);
  assert.match(evidence, /Decision required: none/);
  assert.match(evidence, /clean verdict/i);
  assert.match(evidence, /explicit none/i);

  const bound = reviewSystemPromptForFormat('evidence', { boundaryId: 'b-1' });
  assert.match(bound, /trusted boundary ID[^\n]*b-1/);
  assert.doesNotMatch(bound, /say "No issues found\." in one line/);
});

test('CLI ask evidence mode appends the shared suffix and validates before corpus I/O', async () => {
  let captured;
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await runAskWithDeps({
      paths: ['package.json'],
      question: 'q',
      format: 'evidence',
      stream: false,
    }, executionDeps('Outcome: ok', (request) => {
      captured = request.input;
    }));
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.match(captured.messages[0].content, /Outcome:/);
  assert.match(captured.messages[0].content, /Do not invent/i);

  let resolved = false;
  await assert.rejects(
    () => runAskWithDeps({ paths: ['missing'], question: 'q', format: 'yaml' }, {
      executeModelTask: () => { resolved = true; },
    }),
    /Invalid response format/,
  );
  assert.equal(resolved, false);

  // An explicit empty --format '' is invalid and must fail before any I/O.
  let emptyResolved = false;
  await assert.rejects(
    () => runAskWithDeps({ paths: ['missing'], question: 'q', format: '' }, {
      executeModelTask: () => { emptyResolved = true; },
    }),
    /Invalid response format/,
  );
  assert.equal(emptyResolved, false);

  let reviewResolved = false;
  await assert.rejects(
    () => runReviewWithDeps(undefined, { base: 'main', format: '' }, {
      executeModelTask: () => {
        reviewResolved = true;
      },
    }),
    /Invalid response format/,
  );
  assert.equal(reviewResolved, false);
});

test('CLI ask keeps text prompts unchanged and evidence works through streaming', async () => {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    let textRequest;
    await runAskWithDeps({
      paths: ['package.json'],
      question: 'q',
      system: 'Custom text contract.',
      format: 'text',
      noStream: true,
    }, executionDeps('ok', (request) => {
      textRequest = request.input;
    }));
    assert.equal(textRequest.messages[0].content, 'Custom text contract.');

    let streamRequest;
    await runAskWithDeps({
      paths: ['package.json'],
      question: 'q',
      format: 'evidence',
      stream: true,
    }, executionDeps('Outcome: ok', (request) => {
      streamRequest = request.input;
    }));
    assert.match(streamRequest.messages[0].content, /Evidence:/);
    assert.equal(typeof streamRequest.onText, 'function');
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
});

test('MCP ask and review accept response_format and reject it before work', async () => {
  let askRequest;
  const askResult = await askHandler({
    paths: ['package.json'],
    question: 'q',
    response_format: 'evidence',
  }, executionDeps('ok', (request) => {
    askRequest = request.input;
  }));
  assert.match(askRequest.messages[0].content, /Decision required:/);
  assert.match(askResult, /^ok/);

  let askWork = false;
  await assert.rejects(
    () => askHandler({ paths: ['missing'], question: 'q', response_format: 'yaml' }, {
      executeModelTask: () => { askWork = true; },
    }),
    /Invalid response format/,
  );
  assert.equal(askWork, false);

  // An explicit empty response_format is invalid and must fail before work.
  let emptyWork = false;
  await assert.rejects(
    () => askHandler({ paths: ['missing'], question: 'q', response_format: '' }, {
      executeModelTask: () => { emptyWork = true; },
    }),
    /Invalid response format/,
  );
  assert.equal(emptyWork, false);

  let importedWork = false;
  await assert.rejects(
    () => reviewHandler({ response_format: 'yaml', base: 'main' }, {
      callModel: async () => { importedWork = true; return { content: 'bad', usageReport: '' }; },
    }),
    /Invalid response format/,
  );
  assert.equal(importedWork, false);

  let reviewEmptyWork = false;
  await assert.rejects(
    () => reviewHandler({ response_format: '', base: 'main' }, {
      callModel: async () => {
        reviewEmptyWork = true;
        return { content: 'bad', usageReport: '' };
      },
    }),
    /Invalid response format/,
  );
  assert.equal(reviewEmptyWork, false);
});

test('MCP ask evidence returns the model-authored contract verbatim, never with a trailing usage report', async () => {
  // The evidence contract ends at "Decision required: none". Appending the
  // per-call usage line after it would break the contract, so evidence mode
  // returns the model's text untouched — observability stays in the usage
  // log (`triss usage`), not in the tool result.
  const modelContract = [
    'Outcome: The conservative router sends read-only wording to chat.',
    '',
    'Evidence:',
    '- "update me on the API status" | chat | src/commands/exec.js | 0.9',
    '',
    'Uncertainty:',
    '- none',
    '',
    'Decision required: none',
  ].join('\n');
  const result = await askHandler({
    paths: ['package.json'],
    question: 'q',
    response_format: 'evidence',
  }, executionDeps(modelContract));
  assert.equal(result, modelContract);
  assert.ok(!result.includes('finish:'), `usage report must not be appended: ${result}`);
  assert.ok(result.trimEnd().endsWith('Decision required: none'));
});

test('MCP ask text mode (the default) still appends the usage report after the answer', async () => {
  const answer = 'The router is conservative.';
  const result = await askHandler({
    paths: ['package.json'],
    question: 'q',
  }, executionDeps(answer));
  assert.ok(result.startsWith(answer), `text content must lead, got: ${result}`);
  assert.match(result, /finish:/, 'text mode keeps the historical appended usage report');
});
