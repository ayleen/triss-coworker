// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_EFFORT_LEVELS } from '../src/provider-contract.js';
import { buildOpencodeArgv } from '../src/commands/coder.js';
import { buildOpenCode2RunArgv } from '../src/coder-engines/opencode2.js';
import { buildOmpRunArgv } from '../src/coder-engines/omp.js';
import { buildCrushRunArgv } from '../src/coder-engines/crush.js';

function valueAfter(argv, option) {
  const index = argv.indexOf(option);
  return index === -1 ? undefined : argv[index + 1];
}

for (const effort of MODEL_EFFORT_LEVELS) {
  test(`ENGINE-EFFORT-${effort}: every coding engine handles the explicit logical effort`, () => {
    const openCode = buildOpencodeArgv({ prompt: 'p', model: 'zai/glm-5.2', effort });
    const openCode2 = buildOpenCode2RunArgv({ prompt: 'p', model: 'zai/glm-5.2', effort });
    const omp = buildOmpRunArgv({
      prompt: 'p',
      model: 'zai/glm-5.2',
      effort,
      sessionDir: '/tmp/sessions',
      noSession: true,
    });

    assert.equal(valueAfter(openCode, '--variant'), effort);
    assert.equal(valueAfter(openCode2, '--model'), `zai/glm-5.2#${effort}`);
    assert.equal(openCode2.includes('--variant'), false);
    assert.equal(valueAfter(omp, '--thinking'), effort);
    if (['low', 'medium', 'high'].includes(effort)) {
      const crush = buildCrushRunArgv({ prompt: 'p', effort, restrict: false });
      assert.equal(valueAfter(crush, '--effort'), effort);
    } else {
      assert.throws(
        () => buildCrushRunArgv({ prompt: 'p', effort, restrict: false }),
        new RegExp(`Crush cannot apply effort "${effort}"`),
      );
    }
  });
}

test('ENGINE-EFFORT-native: omitted effort preserves every engine native default', () => {
  assert.equal(buildOpencodeArgv({ prompt: 'p', model: 'zai/glm-5.2' }).includes('--variant'), false);
  assert.equal(valueAfter(buildOpenCode2RunArgv({ prompt: 'p', model: 'zai/glm-5.2' }), '--model'), 'zai/glm-5.2');
  assert.equal(buildOmpRunArgv({ prompt: 'p', model: 'zai/glm-5.2', sessionDir: '/tmp/sessions', noSession: true }).includes('--thinking'), false);
  assert.equal(buildCrushRunArgv({ prompt: 'p', restrict: false }).includes('--effort'), false);
});
