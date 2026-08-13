import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  mkdirSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  START_MARKER,
  END_MARKER,
} from '../src/agent-rules.js';
import {
  planManagedPath,
  applyFileTransaction,
  atomicReplace,
  validateFileTransaction,
} from '../src/marker-transaction.js';

const block = `${START_MARKER}\nnew rules\n${END_MARKER}\n`;
const tempDir = () => mkdtempSync(join(tmpdir(), 'triss-atomic-'));

test('marker planning rejects malformed layouts on real files without modifying them', () => {
  const dir = tempDir();
  try {
    for (const [name, content] of [
      ['partial start', `${START_MARKER}\n`],
      ['partial end', `${END_MARKER}\n`],
      ['reversed', `${END_MARKER}\n${START_MARKER}\n`],
      ['duplicate start', `${START_MARKER}\na\n${START_MARKER}\nb\n${END_MARKER}\n`],
      ['duplicate end', `${START_MARKER}\na\n${END_MARKER}\n${END_MARKER}\n`],
      ['nested', `${START_MARKER}\na\n${START_MARKER}\nb\n${END_MARKER}\n${END_MARKER}\n`],
    ]) {
      const path = join(dir, `${name.replace(/\s+/g, '-')}.md`);
      writeFileSync(path, content);
      assert.throws(
        () => planManagedPath(path, block),
        /invalid Triss marker layout/,
        name,
      );
      assert.equal(readFileSync(path, 'utf8'), content, `${name}: planning must not modify the file`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marker planning rejects a replacement that would install duplicate managed markers', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = '# user content\n';
    writeFileSync(path, original);
    const nestedReplacement = `${START_MARKER}\nnew rules mention ${START_MARKER}\n${END_MARKER}\n`;
    assert.throws(
      () => planManagedPath(path, nestedReplacement),
      /replacement.*exactly one start\/end pair/i,
    );
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planManagedPath appends to an existing file that has no markers', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const existing = '# My project\n\nSome notes.\n';
    writeFileSync(path, existing);
    const plan = planManagedPath(path, block);
    assert.equal(plan.action, 'append');
    assert.equal(plan.changed, true);
    applyFileTransaction([plan]);
    assert.equal(readFileSync(path, 'utf8'), existing + '\n' + block);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generic transaction rejects aliased resolved targets before any replacement', () => {
  const dir = tempDir();
  try {
    const backing = join(dir, 'shared.md');
    const first = join(dir, 'CLAUDE.md');
    const second = join(dir, 'AGENTS.md');
    const original = '# shared user rules\n';
    writeFileSync(backing, original);
    symlinkSync('shared.md', first);
    symlinkSync('shared.md', second);
    const plans = [planManagedPath(first, block), planManagedPath(second, block)];
    let replacements = 0;

    assert.throws(
      () => applyFileTransaction(plans, { replace() { replacements += 1; } }),
      /resolve to the same target/i,
    );
    assert.equal(replacements, 0);
    assert.equal(readFileSync(backing, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transaction canonicalizes lexical and symlinked-parent aliases before collision checks', () => {
  const dir = tempDir();
  try {
    const realDir = join(dir, 'real');
    const aliasDir = join(dir, 'alias');
    mkdirSync(realDir);
    symlinkSync('real', aliasDir);
    const target = join(realDir, 'AGENTS.md');
    const original = '# shared user rules\n';
    writeFileSync(target, original);
    const plans = [
      planManagedPath(`${realDir}/./AGENTS.md`, block),
      planManagedPath(join(aliasDir, 'AGENTS.md'), block),
    ];
    assert.equal(plans[0].targetPath, plans[1].targetPath);
    let replacements = 0;

    assert.throws(
      () => applyFileTransaction(plans, { replace() { replacements += 1; } }),
      /resolve to the same target/i,
    );
    assert.equal(replacements, 0);
    assert.equal(readFileSync(target, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create fails closed when a symlinked parent changes after planning', () => {
  const dir = tempDir();
  try {
    const firstDir = join(dir, 'race-a');
    const secondDir = join(dir, 'race-b');
    const pivot = join(dir, 'pivot');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    symlinkSync('race-a', pivot);
    const destination = join(pivot, 'AGENTS.md');
    const plan = planManagedPath(destination, block);

    assert.throws(
      () => applyFileTransaction([plan], {
        replace(path, content, mode, options) {
          unlinkSync(pivot);
          symlinkSync('race-b', pivot);
          return atomicReplace(path, content, mode, options);
        },
      }),
      /resolved destination changed since planning|refusing to create/i,
    );
    assert.equal(existsSync(join(firstDir, 'AGENTS.md')), false);
    assert.equal(existsSync(join(secondDir, 'AGENTS.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replace fails closed when a symlinked parent changes to a hard-link alias', () => {
  const dir = tempDir();
  try {
    const firstDir = join(dir, 'race-a');
    const secondDir = join(dir, 'race-b');
    const pivot = join(dir, 'pivot');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const first = join(firstDir, 'AGENTS.md');
    const second = join(secondDir, 'AGENTS.md');
    const original = `${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(first, original);
    linkSync(first, second);
    symlinkSync('race-a', pivot);
    const plan = planManagedPath(join(pivot, 'AGENTS.md'), block);

    unlinkSync(pivot);
    symlinkSync('race-b', pivot);
    assert.throws(
      () => applyFileTransaction([plan]),
      /resolved destination changed since planning|refusing to replace/i,
    );
    assert.equal(readFileSync(first, 'utf8'), original);
    assert.equal(readFileSync(second, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planning rejects parent traversal after a symlink before any filesystem mutation', () => {
  const dir = tempDir();
  try {
    const other = join(dir, 'other');
    const child = join(other, 'child');
    const pivot = join(dir, 'pivot');
    mkdirSync(child, { recursive: true });
    symlinkSync('other/child', pivot);
    const destination = `${pivot}/../AGENTS.md`;

    assert.throws(
      () => planManagedPath(destination, block),
      /parent traversal|not allowed/i,
    );
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
    assert.equal(existsSync(join(other, 'AGENTS.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-insensitive filesystems reject missing case aliases before replacement', (t) => {
  const dir = tempDir();
  try {
    const probe = join(dir, 'CaseProbe');
    writeFileSync(probe, 'probe');
    if (!existsSync(join(dir, 'caseprobe'))) {
      t.skip('filesystem is case-sensitive');
      return;
    }
    unlinkSync(probe);

    const upper = join(dir, 'MISSING.md');
    const lower = join(dir, 'missing.md');
    const plans = [planManagedPath(upper, block), planManagedPath(lower, block)];
    let replacements = 0;
    assert.throws(
      () => applyFileTransaction(plans, {
        replace() {
          replacements += 1;
          throw new Error('replacement must not run');
        },
      }),
      /same target|refusing transaction/i,
    );
    assert.equal(replacements, 0);
    assert.equal(existsSync(upper), false);
    assert.equal(existsSync(lower), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-sensitive filesystems preserve distinct missing case aliases', (t) => {
  const dir = tempDir();
  try {
    const probe = join(dir, 'CaseProbe');
    writeFileSync(probe, 'probe');
    if (existsSync(join(dir, 'caseprobe'))) {
      t.skip('filesystem is case-insensitive');
      return;
    }

    assert.doesNotThrow(() => validateFileTransaction([
      planManagedPath(join(dir, 'MISSING.md'), block),
      planManagedPath(join(dir, 'missing.md'), block),
    ]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-insensitive filesystems reject missing non-ASCII aliases before replacement', (t) => {
  const dir = tempDir();
  try {
    const probe = join(dir, 'CaseProbe');
    writeFileSync(probe, 'probe');
    if (!existsSync(join(dir, 'caseprobe'))) {
      t.skip('filesystem is case-sensitive');
      return;
    }
    unlinkSync(probe);

    const plans = [
      planManagedPath(join(dir, 'Σ.md'), block),
      planManagedPath(join(dir, 'ς.md'), block),
    ];
    let replacements = 0;
    assert.throws(
      () => applyFileTransaction(plans, {
        replace() {
          replacements += 1;
          throw new Error('replacement must not run');
        },
      }),
      /non-ASCII destination is ambiguous|same target|refusing transaction/i,
    );
    assert.equal(replacements, 0);
    assert.equal(existsSync(join(dir, 'Σ.md')), false);
    assert.equal(existsSync(join(dir, 'ς.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-insensitive detection survives a wrong-case existing parent spelling', (t) => {
  const dir = tempDir();
  try {
    const storedParent = join(dir, 'caseprobe');
    mkdirSync(storedParent);
    const queriedParent = join(dir, 'Caseprobe');
    if (!existsSync(queriedParent)) {
      t.skip('filesystem is case-sensitive');
      return;
    }

    const plans = [
      planManagedPath(join(queriedParent, 'MISSING.md'), block),
      planManagedPath(join(queriedParent, 'missing.md'), block),
    ];
    let replacements = 0;
    assert.throws(
      () => applyFileTransaction(plans, {
        replace() {
          replacements += 1;
          throw new Error('replacement must not run');
        },
      }),
      /same target|refusing transaction/i,
    );
    assert.equal(replacements, 0);
    assert.deepEqual(readdirSync(storedParent), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-insensitive filesystem roots reject missing case aliases in preflight', (t) => {
  let upperUsers;
  let lowerUsers;
  try {
    upperUsers = statSync('/Users', { bigint: true });
    lowerUsers = statSync('/users', { bigint: true });
  } catch {
    t.skip('no case-insensitive root alias is available');
    return;
  }
  if (upperUsers.dev !== lowerUsers.dev || upperUsers.ino !== lowerUsers.ino) {
    t.skip('root filesystem is case-sensitive');
    return;
  }

  const upper = '/TRISS_CASE_ALIAS_REVIEW_NEVER_EXISTS_7D2F';
  const lower = upper.toLowerCase();
  assert.equal(existsSync(upper), false);
  assert.equal(existsSync(lower), false);
  assert.throws(
    () => validateFileTransaction([
      planManagedPath(upper, block),
      planManagedPath(lower, block),
    ]),
    /same target|refusing transaction/i,
  );
  assert.equal(existsSync(upper), false);
  assert.equal(existsSync(lower), false);
});

test('unknown empty-directory case semantics allow unrelated ASCII targets', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readdirSync(dir), []);
    assert.doesNotThrow(() => validateFileTransaction([
      planManagedPath(join(dir, 'AGENTS.md'), block),
      planManagedPath(join(dir, 'CLAUDE.md'), block),
    ]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown case semantics reject Unicode-to-ASCII aliases before replacement', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readdirSync(dir), []);
    const plans = [
      planManagedPath(join(dir, 'K.md'), block),
      planManagedPath(join(dir, 'K.md'), block),
    ];
    let replacements = 0;
    assert.throws(
      () => applyFileTransaction(plans, {
        replace() {
          replacements += 1;
          throw new Error('replacement must not run');
        },
      }),
      /same target|refusing transaction/i,
    );
    assert.equal(replacements, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing empty file receives the managed block without leading blank lines', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, '');
    const plan = planManagedPath(path, block);
    assert.equal(plan.action, 'append');
    assert.deepEqual(plan.replacement, Buffer.from(block));
    applyFileTransaction([plan]);
    assert.deepEqual(readFileSync(path), Buffer.from(block));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback removes a file created by an earlier plan when a later apply fails', () => {
  const dir = tempDir();
  try {
    const created = join(dir, 'CLAUDE.md');
    const existing = join(dir, 'AGENTS.md');
    const existingOriginal = `${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(existing, existingOriginal);
    const plans = [
      planManagedPath(created, block),
      planManagedPath(existing, block),
    ];
    assert.equal(plans[0].action, 'create');
    assert.equal(plans[0].original, null);
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode) {
        calls += 1;
        if (calls === 2) throw new Error('simulated failure after create');
        atomicReplace(path, content, mode);
      },
    }), /simulated failure after create/);
    assert.ok(!existsSync(created), 'created file must be removed during rollback');
    assert.equal(readFileSync(existing, 'utf8'), existingOriginal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback restores the exact original bytes of an appended file', () => {
  const dir = tempDir();
  try {
    const appended = join(dir, 'CLAUDE.md');
    const existing = join(dir, 'AGENTS.md');
    const appendedOriginal = '# Only my content\n';
    const existingOriginal = `${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(appended, appendedOriginal);
    writeFileSync(existing, existingOriginal);
    const plans = [
      planManagedPath(appended, block),
      planManagedPath(existing, block),
    ];
    assert.equal(plans[0].action, 'append');
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode) {
        calls += 1;
        if (calls === 2) throw new Error('simulated second-target failure');
        atomicReplace(path, content, mode);
      },
    }), /simulated second-target failure/);
    assert.equal(
      readFileSync(appended, 'utf8'),
      appendedOriginal,
      'appended file must be restored byte-for-byte',
    );
    assert.equal(readFileSync(existing, 'utf8'), existingOriginal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic transaction preserves mode and symlink and removes temps', () => {
  const dir = tempDir();
  try {
    const target = join(dir, 'AGENTS.real.md');
    const link = join(dir, 'AGENTS.md');
    writeFileSync(target, `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`);
    chmodSync(target, 0o640);
    symlinkSync('AGENTS.real.md', link);
    const plan = planManagedPath(link, block);
    assert.equal(plan.changed, true);
    applyFileTransaction([plan]);
    assert.equal(readlinkSync(link), 'AGENTS.real.md');
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.equal(readFileSync(target, 'utf8'), `before\n${block.trimEnd()}\nafter\n`);
    assert.deepEqual(readdirSync(dir).sort(), ['AGENTS.md', 'AGENTS.real.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGKILL at the final rename leaves a complete old or new target pathname', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;
    const replacement = `before\n${START_MARKER}\nnew\n${END_MARKER}\nafter\n`;
    writeFileSync(path, original);
    const script = `
      import { atomicReplace } from ${JSON.stringify(new URL('../src/marker-transaction.js', import.meta.url).href)};
      import { renameSync } from 'node:fs';
      const [target, content] = process.argv.slice(1);
      atomicReplace(target, content, 0o644, {
        rename(from, to) {
          renameSync(from, to);
          process.kill(process.pid, 'SIGKILL');
        },
      });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path, replacement], {
      encoding: 'utf8',
    });
    assert.equal(result.signal, 'SIGKILL', `child should die at the final rename: ${result.stderr}`);
    assert.ok(existsSync(path), 'the public target pathname must remain occupied after a crash');
    assert.ok(
      [original, replacement].includes(readFileSync(path, 'utf8')),
      'a crash may leave only a complete old or new file, never a missing/torn target',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory swapped in before final replacement remains visible and is not moved aside', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;
    writeFileSync(path, original);
    const plan = planManagedPath(path, block);
    assert.throws(() => applyFileTransaction([plan], {
      replace(targetPath, content, mode, options) {
        return atomicReplace(targetPath, content, mode, {
          ...options,
          rename(from, to) {
            unlinkSync(to);
            mkdirSync(to);
            return renameSync(from, to);
          },
        });
      },
    }), /non-regular|EISDIR|directory|refusing/i);
    assert.equal(statSync(path).isDirectory(), true, 'the raced directory must remain at the public pathname');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.triss-')),
      [],
      'a failed directory race must not leave hidden backups or temporary files',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unchanged plans do not mutate the destination', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const content = `before\n${block.trimEnd()}\nafter\n`;
    writeFileSync(path, content);
    const before = statSync(path);
    const plan = planManagedPath(path, block);
    assert.equal(plan.changed, false);
    applyFileTransaction([plan]);
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transaction preflight rejects a later malformed target without writing earlier target', () => {
  const dir = tempDir();
  try {
    const first = join(dir, 'CLAUDE.md');
    const second = join(dir, 'AGENTS.md');
    const firstContent = 'notes\n';
    writeFileSync(first, firstContent);
    writeFileSync(second, `${START_MARKER}\npartial`);
    const firstPlan = planManagedPath(first, block);
    assert.throws(() => planManagedPath(second, block), /marker/i);
    assert.equal(readFileSync(first, 'utf8'), firstContent);
    assert.equal(firstPlan.changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transaction rolls back an earlier replacement when a later replacement fails', () => {
  const dir = tempDir();
  try {
    const first = join(dir, 'CLAUDE.md');
    const second = join(dir, 'AGENTS.md');
    const firstOriginal = `${START_MARKER}\nold one\n${END_MARKER}\n`;
    const secondOriginal = `${START_MARKER}\nold two\n${END_MARKER}\n`;
    writeFileSync(first, firstOriginal);
    writeFileSync(second, secondOriginal);
    const plans = [
      planManagedPath(first, block),
      planManagedPath(second, block),
    ];
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode) {
        calls += 1;
        if (calls === 2) throw new Error('simulated second-target failure');
        atomicReplace(path, content, mode);
      },
    }), /simulated second-target failure/);
    assert.equal(readFileSync(first, 'utf8'), firstOriginal);
    assert.equal(readFileSync(second, 'utf8'), secondOriginal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marker planning rejects non-regular destinations and reports rollback failures', () => {
  const dir = tempDir();
  try {
    const directory = join(dir, 'AGENTS.md');
    mkdirSync(directory);
    assert.throws(
      () => planManagedPath(directory, block),
      /AGENTS\.md.*regular file/i,
    );

    const first = join(dir, 'CLAUDE.md');
    const second = join(dir, 'AGENTS-file.md');
    const original = `${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(first, original);
    writeFileSync(second, original);
    const plans = [
      planManagedPath(first, block),
      planManagedPath(second, block),
    ];
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode) {
        calls += 1;
        if (calls === 2) throw new Error('later apply failed');
        if (calls === 3) throw new Error('rollback denied');
        atomicReplace(path, content, mode);
      },
    }), /later apply failed.*rollback failures.*rollback denied/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── finding 1: apply-time CAS / precondition revalidation ────────────────────

test('apply refuses to clobber a file that appeared after a create plan', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'CLAUDE.md');
    const plan = planManagedPath(path, block);
    assert.equal(plan.action, 'create');
    assert.equal(plan.original, null);
    const userContent = '# created by the user after planning\n';
    writeFileSync(path, userContent);
    assert.throws(() => applyFileTransaction([plan]), /appeared|clobber|refusing/i);
    assert.equal(
      readFileSync(path, 'utf8'),
      userContent,
      'the newly-appeared user file must be left untouched',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create install remains no-clobber when a file appears after apply revalidation', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'CLAUDE.md');
    const plan = planManagedPath(path, block);
    const userContent = '# won the create race\n';
    assert.throws(() => applyFileTransaction([plan], {
      replace(targetPath, content, mode, options) {
        writeFileSync(targetPath, userContent);
        return atomicReplace(targetPath, content, mode, options);
      },
    }), /EEXIST|exist/i);
    assert.equal(readFileSync(path, 'utf8'), userContent);
    assert.deepEqual(readdirSync(dir), ['CLAUDE.md'], 'failed no-clobber install must clean its temp file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply refuses to overwrite a destination whose content changed after planning', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;
    writeFileSync(path, original);
    const plan = planManagedPath(path, block);
    assert.equal(plan.action, 'update');
    const userContent = original + '# user edit after planning\n';
    writeFileSync(path, userContent);
    assert.throws(() => applyFileTransaction([plan]), /content changed|refusing/i);
    assert.equal(
      readFileSync(path, 'utf8'),
      userContent,
      'the user edit must not be overwritten',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply fails closed when the symlink is swapped after planning', () => {
  const dir = tempDir();
  try {
    const target = join(dir, 'AGENTS.real.md');
    const other = join(dir, 'OTHER.md');
    const link = join(dir, 'AGENTS.md');
    writeFileSync(target, `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`);
    writeFileSync(other, `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`);
    symlinkSync('AGENTS.real.md', link);
    const plan = planManagedPath(link, block);
    assert.equal(plan.symlink, true);
    unlinkSync(link);
    symlinkSync('OTHER.md', link);
    assert.throws(() => applyFileTransaction([plan]), /changed|swap|refusing|identity/i);
    assert.equal(readlinkSync(link), 'OTHER.md', 'the swapped symlink must be left alone');
    assert.equal(
      readFileSync(target, 'utf8'),
      `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`,
      'the originally-planned target must be untouched',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback never removes an intervening user file that replaced a transaction-created file', () => {
  const dir = tempDir();
  try {
    const created = join(dir, 'CLAUDE.md');
    const existing = join(dir, 'AGENTS.md');
    const existingOriginal = `${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(existing, existingOriginal);
    const plans = [
      planManagedPath(created, block),
      planManagedPath(existing, block),
    ];
    assert.equal(plans[0].action, 'create');
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode) {
        calls += 1;
        if (calls === 1) {
          const written = atomicReplace(path, content, mode);
          // The user intervenes: the transaction-created file is removed and
          // replaced by their own file before rollback runs.
          rmSync(path, { force: true });
          writeFileSync(path, '# intervening user file\n');
          return written;
        }
        if (calls === 2) throw new Error('second target failed');
        return atomicReplace(path, content, mode);
      },
    }), /second target failed.*rollback failures.*interven|refusing/s);
    assert.equal(
      readFileSync(created, 'utf8'),
      '# intervening user file\n',
      'rollback must not remove the intervening user file',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback restores original bytes only when the replaced file is still the transaction output', () => {
  const dir = tempDir();
  try {
    const first = join(dir, 'CLAUDE.md');
    const second = join(dir, 'AGENTS.md');
    const firstOriginal = `${START_MARKER}\nold one\n${END_MARKER}\n`;
    const secondOriginal = `${START_MARKER}\nold two\n${END_MARKER}\n`;
    writeFileSync(first, firstOriginal);
    writeFileSync(second, secondOriginal);
    const plans = [
      planManagedPath(first, block),
      planManagedPath(second, block),
    ];
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode) {
        calls += 1;
        if (calls === 1) {
          const written = atomicReplace(path, content, mode);
          // The user edits the just-replaced file before rollback runs.
          writeFileSync(path, `${START_MARKER}\nuser overwrote output\n${END_MARKER}\n`);
          return written;
        }
        if (calls === 2) throw new Error('second target failed');
        return atomicReplace(path, content, mode);
      },
    }), /second target failed.*rollback failures.*refusing|changed/s);
    assert.equal(
      readFileSync(first, 'utf8'),
      `${START_MARKER}\nuser overwrote output\n${END_MARKER}\n`,
      'rollback must not overwrite an intervening user edit',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── finding 4: byte-exact preservation after END_MARKER ──────────────────────

test('rollback revalidates transaction output while restoring original bytes', () => {
  const dir = tempDir();
  try {
    const first = join(dir, 'CLAUDE.md');
    const second = join(dir, 'AGENTS.md');
    const firstOriginal = `${START_MARKER}\nold one\n${END_MARKER}\n`;
    const secondOriginal = `${START_MARKER}\nold two\n${END_MARKER}\n`;
    const intervening = `${START_MARKER}\nuser edit during rollback\n${END_MARKER}\n`;
    writeFileSync(first, firstOriginal);
    writeFileSync(second, secondOriginal);
    const plans = [
      planManagedPath(first, block),
      planManagedPath(second, block),
    ];
    let calls = 0;
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode, options) {
        calls += 1;
        if (calls === 1) return atomicReplace(path, content, mode, options);
        if (calls === 2) throw new Error('second target failed');
        writeFileSync(path, intervening);
        return atomicReplace(path, content, mode, options);
      },
    }), /second target failed.*rollback failures.*changed|refusing/s);
    assert.equal(
      readFileSync(first, 'utf8'),
      intervening,
      'rollback must not overwrite an edit made after its initial ownership check',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update preserves every byte after the end marker, including multiple newlines', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `before\n${START_MARKER}\nold rules\n${END_MARKER}\n\n\nTail after the gap.\n`;
    writeFileSync(path, original);
    const plan = planManagedPath(path, block);
    assert.equal(plan.action, 'update');
    applyFileTransaction([plan]);
    assert.equal(
      readFileSync(path, 'utf8'),
      `before\n${block.trimEnd()}\n\n\nTail after the gap.\n`,
      'only the managed block may change; bytes after END_MARKER must be identical',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update preserves trailing newlines at the end of the file', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `${START_MARKER}\nold\n${END_MARKER}\n\n\n`;
    writeFileSync(path, original);
    const plan = planManagedPath(path, block);
    assert.equal(plan.action, 'update');
    applyFileTransaction([plan]);
    assert.equal(
      readFileSync(path, 'utf8'),
      `${block.trimEnd()}\n\n\n`,
      'the three trailing newlines after END_MARKER must survive the update',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update preserves a CRLF or adjacent tail exactly as stored after the end marker', () => {
  const dir = tempDir();
  try {
    for (const [name, tail] of [['crlf', '\r\nTail\r\n'], ['adjacent', 'Tail']]) {
      const path = join(dir, `${name}.md`);
      writeFileSync(path, `${START_MARKER}\nold\n${END_MARKER}${tail}`);
      const plan = planManagedPath(path, block);
      applyFileTransaction([plan]);
      assert.equal(readFileSync(path, 'utf8'), `${block.trimEnd()}${tail}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── finding 5: loop writeSync on short writes via an injectable writer ───────

test('atomicReplace loops the writer until the whole buffer is written (short writes)', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const content = 'x'.repeat(10) + '\n';
    let writes = 0;
    atomicReplace(path, content, 0o600, {
      write(fd, buffer, offset, length) {
        writes += 1;
        const n = Math.min(3, length); // force a short write
        const written = writeSync(fd, buffer, offset, n);
        assert.equal(written, n, 'short-write seam must report the bytes it wrote');
        return written;
      },
    });
    assert.ok(writes >= 4, `expected the writer to be invoked repeatedly, got ${writes} call(s)`);
    assert.equal(readFileSync(path, 'utf8'), content, 'the complete content must land on disk');
    assert.equal(statSync(path).mode & 0o777, 0o600, 'mode must still be preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply fails closed when a symlink swaps after precondition verification', () => {
  const dir = tempDir();
  try {
    const target = join(dir, 'AGENTS.real.md');
    const other = join(dir, 'OTHER.md');
    const link = join(dir, 'AGENTS.md');
    writeFileSync(target, `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`);
    writeFileSync(other, `before\n${START_MARKER}\nother\n${END_MARKER}\nafter\n`);
    symlinkSync('AGENTS.real.md', link);
    const plan = planManagedPath(link, block);
    assert.throws(() => applyFileTransaction([plan], {
      replace(targetPath, content, mode, options) {
        unlinkSync(link);
        symlinkSync('OTHER.md', link);
        return atomicReplace(targetPath, content, mode, options);
      },
    }), /changed|swap|refusing|identity/i);
    assert.equal(readlinkSync(link), 'OTHER.md');
    assert.equal(readFileSync(target, 'utf8'), `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply fails closed when mode changes after precondition verification', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;
    writeFileSync(path, original);
    chmodSync(path, 0o640);
    const plan = planManagedPath(path, block);
    assert.throws(() => applyFileTransaction([plan], {
      replace(targetPath, content, mode, options) {
        chmodSync(targetPath, 0o600);
        return atomicReplace(targetPath, content, mode, options);
      },
    }), /mode|changed|refusing/i);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planning and replacement preserve invalid bytes outside the managed block', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const prefix = Buffer.from([0x70, 0x72, 0x65, 0x66, 0xff, 0x00, 0x69, 0x6e, 0x67, 0x2d]);
    const suffix = Buffer.from([0x2d, 0x74, 0x61, 0x69, 0x6c, 0xfe, 0x80, 0x00, 0x0a]);
    const original = Buffer.concat([
      prefix,
      Buffer.from(`${START_MARKER}\nold\n${END_MARKER}`),
      suffix,
    ]);
    writeFileSync(path, original);
    const plan = planManagedPath(path, block);
    applyFileTransaction([plan]);
    const result = readFileSync(path);
    assert.deepEqual(result.subarray(0, prefix.length), prefix);
    assert.deepEqual(result.subarray(result.length - suffix.length), suffix);
    assert.ok(result.includes(Buffer.from(block.trimEnd(), 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback removes only the exact created inode when the path is swapped before unlink', () => {
  const dir = tempDir();
  try {
    const created = join(dir, 'CLAUDE.md');
    const existing = join(dir, 'AGENTS.md');
    writeFileSync(existing, `${START_MARKER}\nold\n${END_MARKER}\n`);
    const plans = [planManagedPath(created, block), planManagedPath(existing, block)];
    const userContent = '# intervening user file\n';
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode, options) {
        if (path === plans[1].targetPath) throw new Error('second target failed');
        return atomicReplace(path, content, mode, options);
      },
      remove(path) {
        writeFileSync(created, userContent);
        unlinkSync(path);
      },
    }), /second target failed/);
    assert.equal(readFileSync(created, 'utf8'), userContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback preserves the original removal error when the backup is already gone', () => {
  const dir = tempDir();
  try {
    const created = join(dir, 'CLAUDE.md');
    const existing = join(dir, 'AGENTS.md');
    writeFileSync(existing, `${START_MARKER}\nold\n${END_MARKER}\n`);
    const plans = [planManagedPath(created, block), planManagedPath(existing, block)];
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode, options) {
        if (path === plans[1].targetPath) throw new Error('second target failed');
        return atomicReplace(path, content, mode, options);
      },
      remove(backup) {
        unlinkSync(backup);
        throw new Error('remove failed after unlink');
      },
    }), /second target failed.*rollback failures.*remove failed after unlink/s);
    assert.equal(existsSync(created), false, 'the transaction-created path must remain absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback reports both removal and restore failures without clobbering user data', () => {
  const dir = tempDir();
  try {
    const created = join(dir, 'CLAUDE.md');
    const existing = join(dir, 'AGENTS.md');
    const userContent = '# intervening user file\n';
    writeFileSync(existing, `${START_MARKER}\nold\n${END_MARKER}\n`);
    const plans = [planManagedPath(created, block), planManagedPath(existing, block)];
    assert.throws(() => applyFileTransaction(plans, {
      replace(path, content, mode, options) {
        if (path === plans[1].targetPath) throw new Error('second-apply-failure');
        return atomicReplace(path, content, mode, options);
      },
      remove() {
        writeFileSync(created, userContent);
        throw new Error('primary-remove-failure');
      },
    }), (error) => {
      assert.match(error.message, /second-apply-failure/);
      assert.match(error.message, /primary-remove-failure/);
      assert.match(error.message, /unable to restore|EEXIST|restore/i);
      return true;
    });
    assert.equal(readFileSync(created, 'utf8'), userContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create-only post-link temp cleanup failure is compensated during rollback', () => {
  const dir = tempDir();
  try {
    const created = join(dir, 'CLAUDE.md');
    const plan = planManagedPath(created, block);
    assert.throws(() => applyFileTransaction([plan], {
      replace(path, content, mode, options) {
        return atomicReplace(path, content, mode, {
          ...options,
          unlink(temp) {
            if (temp.includes('.triss-')) throw new Error('post-link temp cleanup failed');
            unlinkSync(temp);
          },
        });
      },
    }), /post-link temp cleanup failed/);
    assert.equal(existsSync(created), false, 'failed create must not leave the installed destination');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replacement uses no hidden backup and leaves no temporary sibling', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    const original = `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;
    writeFileSync(path, original);
    const plan = planManagedPath(path, block);
    applyFileTransaction([plan], {
      replace(targetPath, content, mode, options) {
        return atomicReplace(targetPath, content, mode, options);
      },
    });
    assert.notDeepEqual(readFileSync(path), Buffer.from(original));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.triss-')),
      [],
      'failed replacement must not leave a same-directory backup or temp file',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── finding 7: cleanup failures preserve the original error ──────────────────

test('cleanup failure surfaces an AggregateError carrying both the cleanup and original errors', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'AGENTS.md');
    assert.throws(
      () => atomicReplace(path, 'content\n', 0o644, {
        write(fd, _buffer, _offset, _length) {
          closeSync(fd); // the next close in cleanup will fail with EBADF
          throw new Error('injected write failure');
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError, 'must be an AggregateError with both errors');
        assert.equal(error.errors.length, 2, 'cleanup error + original error');
        assert.equal(error.errors[0].code, 'EBADF', 'cleanup error must be surfaced');
        assert.equal(error.errors[1].message, 'injected write failure', 'original failure must be preserved');
        assert.match(error.message, /temporary-file cleanup failed/);
        assert.match(error.message, /injected write failure/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
