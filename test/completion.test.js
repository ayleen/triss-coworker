import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { runCompletion } from '../src/commands/completion.js';

function fixtureProgram() {
  const program = new Command();
  program.name('triss').description('test');

  program.command('ask').description('ask cmd').action(() => {});
  program.command('write').description('write cmd').action(() => {});

  const config = program.command('config').description('config group');
  config.command('wizard').description('cfg wizard').action(() => {});
  config.command('set').description('cfg set').action(() => {});
  config.command('get').description('cfg get').action(() => {});

  return program;
}

function captureStdout(fn) {
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    out += String(s);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

test('bash completion lists top-level commands and per-group subcommands', () => {
  const program = fixtureProgram();
  const out = captureStdout(() => runCompletion('bash', program));
  assert.match(out, /complete -F _triss_completion triss/);
  assert.match(out, /compgen -W "ask write config /);
  assert.match(out, /case "\$\{COMP_WORDS\[1\]\}" in[\s\S]*config\)[\s\S]*wizard set get/);
});

test('zsh completion contains #compdef and command descriptions', () => {
  const program = fixtureProgram();
  const out = captureStdout(() => runCompletion('zsh', program));
  assert.match(out, /^#compdef triss/);
  assert.match(out, /'ask:ask cmd'/);
  assert.match(out, /'config:config group'/);
  assert.match(out, /'wizard:cfg wizard'/);
});

test('completion rejects unknown shells', () => {
  const program = fixtureProgram();
  assert.throws(() => runCompletion('fish', program), /Unknown shell/);
});

test('completion requires a program argument', () => {
  assert.throws(() => runCompletion('bash'), /requires the Commander program/);
});
