// Shell-completion generator. Walks the Commander tree and emits a
// completion script for bash or zsh. The generated scripts complete:
//   - top-level command names
//   - subcommand names inside command groups (e.g. `triss config <Tab>`)
//   - long-form option flags for every leaf command (e.g. `--local`,
//     `--force`, `--standard`)
// Option values (paths, JQL, URLs, free-form text) are intentionally not
// completed — the agent or user already knows what they want there.

function leafFlags(cmd) {
  const flags = (cmd.options || [])
    .map((o) => o.long)
    .filter(Boolean)
    .filter((f) => f !== '--help' && f !== '--version');
  flags.push('--help');
  return flags;
}

function collectTree(program) {
  const top = [];
  const groups = {}; // groupName -> { subs: [{name, description, flags}], flags }
  const leaves = {}; // leafName -> { flags }

  for (const cmd of program.commands || []) {
    if (cmd.name() === 'help' || cmd._hidden) continue;
    const name = cmd.name();
    top.push({ name, description: cmd.description() || '' });

    if (cmd.commands?.length) {
      groups[name] = {
        subs: cmd.commands
          .filter((s) => s.name() !== 'help' && !s._hidden)
          .map((s) => ({
            name: s.name(),
            description: s.description() || '',
            flags: leafFlags(s),
          })),
      };
    } else {
      leaves[name] = { flags: leafFlags(cmd) };
    }
  }
  return { top, groups, leaves };
}

function bashScript(program) {
  const { top, groups, leaves } = collectTree(program);
  const topNames = top.map((c) => c.name).join(' ');

  const leafBlocks = Object.entries(leaves)
    .map(
      ([name, { flags }]) =>
        `    ${name})
      COMPREPLY=( $(compgen -W "${flags.join(' ')}" -- "\${cur}") )
      return 0
      ;;`,
    )
    .join('\n');

  const groupBlocks = Object.entries(groups)
    .map(([name, { subs }]) => {
      const subNames = subs.map((s) => s.name).join(' ');
      const subCases = subs
        .map(
          (s) =>
            `        ${s.name})
          COMPREPLY=( $(compgen -W "${s.flags.join(' ')}" -- "\${cur}") )
          return 0
          ;;`,
        )
        .join('\n');
      return `    ${name})
      if [ "\${COMP_CWORD}" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "${subNames}" -- "\${cur}") )
        return 0
      fi
      case "\${COMP_WORDS[2]}" in
${subCases}
      esac
      ;;`;
    })
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
${leafBlocks}
${groupBlocks}
  esac
}
complete -F _triss_completion triss
`;
}

function zshScript(program) {
  const { top, groups, leaves } = collectTree(program);
  const topLines = top.map((c) => `    '${c.name}:${escapeZsh(c.description)}'`).join('\n');

  const leafBlocks = Object.entries(leaves)
    .map(
      ([name, { flags }]) =>
        `    ${name})
      _values 'flag' \\
${flags.map((f) => `        '${f}'`).join(' \\\n')}
      ;;`,
    )
    .join('\n');

  const groupBlocks = Object.entries(groups)
    .map(([name, { subs }]) => {
      const subLines = subs.map((s) => `        '${s.name}:${escapeZsh(s.description)}'`).join('\n');
      const subCases = subs
        .map(
          (s) =>
            `        ${s.name})
          _values 'flag' \\
${s.flags.map((f) => `            '${f}'`).join(' \\\n')}
          ;;`,
        )
        .join('\n');
      return `    ${name})
      if (( CURRENT == 3 )); then
        _values 'subcommand' \\
${subLines.replace(/^/gm, '    ')}
        return
      fi
      case \${words[3]} in
${subCases}
      esac
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
${leafBlocks}
${groupBlocks}
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
