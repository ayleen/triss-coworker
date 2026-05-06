// Shell-completion generator. Walks the Commander tree and emits a
// completion script for bash or zsh. The generated scripts only complete
// command/subcommand names — they intentionally do not try to complete
// option values, since most of those are free-form (paths, JQL, URLs).

function collectCommands(program) {
  const top = [];
  const subs = {};
  for (const cmd of program.commands || []) {
    if (cmd.name() === 'help' || cmd._hidden) continue;
    top.push({ name: cmd.name(), description: cmd.description() || '' });
    if (cmd.commands?.length) {
      subs[cmd.name()] = cmd.commands
        .filter((s) => s.name() !== 'help' && !s._hidden)
        .map((s) => ({ name: s.name(), description: s.description() || '' }));
    }
  }
  return { top, subs };
}

function bashScript(program) {
  const { top, subs } = collectCommands(program);
  const topNames = top.map((c) => c.name).join(' ');
  const cases = Object.entries(subs)
    .map(
      ([cmd, list]) =>
        `    ${cmd})\n      if [ "\${COMP_CWORD}" -eq 2 ]; then\n        COMPREPLY=( $(compgen -W "${list
          .map((s) => s.name)
          .join(' ')}" -- "\${cur}") )\n        return 0\n      fi\n      ;;`,
    )
    .join('\n');

  return `# triss bash completion. Source this file or eval the output:
#   eval "$(triss completion bash)"
_triss_completion() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${topNames} --help --version" -- "\${cur}") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _triss_completion triss
`;
}

function zshScript(program) {
  const { top, subs } = collectCommands(program);
  const topLines = top
    .map((c) => `    '${c.name}:${escapeZsh(c.description)}'`)
    .join('\n');
  const subFns = Object.entries(subs)
    .map(([cmd, list]) => {
      const lines = list.map((s) => `        '${s.name}:${escapeZsh(s.description)}'`).join('\n');
      return `    ${cmd})
      _values 'subcommand' \\
${lines}
      ;;`;
    })
    .join('\n');

  return `#compdef triss
# triss zsh completion. Source this file from a directory in $fpath, or:
#   eval "$(triss completion zsh)"
_triss() {
  local -a commands
  commands=(
${topLines}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case \${words[2]} in
${subFns}
  esac
}
_triss "$@"
`;
}

function escapeZsh(s) {
  return String(s).replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

export function runCompletion(shell, program) {
  if (!program) throw new Error('runCompletion requires the Commander program');
  const root = program.parent || program;
  switch ((shell || '').toLowerCase()) {
    case 'bash':
      process.stdout.write(bashScript(root));
      return;
    case 'zsh':
      process.stdout.write(zshScript(root));
      return;
    default:
      throw new Error(`Unknown shell "${shell}". Supported: bash, zsh.`);
  }
}
