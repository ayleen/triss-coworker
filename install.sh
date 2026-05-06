#!/usr/bin/env bash
# Triss Coworker — bash installer (alternative to `npm i -g triss-coworker`)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ayleen/triss-coworker/main/install.sh | bash
#
# Requires: node >= 18, git, npm (for `npm install --omit=dev`).
# Does NOT use `npm link` — instead drops a plain symlink in $BIN_DIR.
# This avoids surprises with nvm / system-Node mixups and never touches
# your global node_modules.
set -euo pipefail

REPO="https://github.com/ayleen/triss-coworker.git"
INSTALL_DIR="${TRISS_HOME:-${HOME}/.local/share/triss-coworker}"
BIN_DIR="${TRISS_BIN_DIR:-${HOME}/.local/bin}"

echo "=== Triss Coworker installer ==="

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required (>=18). Install via https://nodejs.org/ or nvm." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "✗ Node.js ${NODE_MAJOR} is too old. Triss requires Node.js >= 18." >&2
  echo "  Upgrade via nvm/fnm, or download from https://nodejs.org/." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "✗ git is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm is required (it normally ships with Node.js)." >&2
  exit 1
fi

if [ -d "${INSTALL_DIR}/.git" ]; then
  echo "[1/3] Updating existing checkout at ${INSTALL_DIR}..."
  git -C "${INSTALL_DIR}" pull --ff-only
else
  echo "[1/3] Cloning into ${INSTALL_DIR}..."
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --depth=1 "${REPO}" "${INSTALL_DIR}"
fi

echo "[2/3] Installing dependencies..."
( cd "${INSTALL_DIR}" && npm install --omit=dev --silent )

echo "[3/3] Linking 'triss' into ${BIN_DIR}..."
mkdir -p "${BIN_DIR}"
chmod +x "${INSTALL_DIR}/bin/triss.js"
ln -sf "${INSTALL_DIR}/bin/triss.js" "${BIN_DIR}/triss"

# Warn if BIN_DIR isn't on PATH, so the user immediately sees why
# `triss` may appear "missing" right after install.
case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo ""
    echo "⚠ ${BIN_DIR} is not on your PATH."
    echo "  Add this line to your shell profile (~/.zshrc, ~/.bashrc):"
    echo "    export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "✓ Installed. Run 'triss --help' to get started."
echo ""
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  cat <<EOF
Next: configure your credentials (DeepSeek + any integrations) interactively:

  triss config wizard

(or 'triss config wizard --local' to save inside the current project only)
EOF
fi
