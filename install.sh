#!/bin/bash

BASE_URL="https://raw.githubusercontent.com/Benoitprrn/paywait-extension/main"

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║         Installing PayWait            ║"
echo "╚═══════════════════════════════════════╝"
echo ""
echo "Earn money while your AI codes."
echo "One ad. Every time you wait. You keep 50%."
echo ""
# Token en argument ou saisi interactivement
if [ -n "$1" ]; then
  TOKEN="$1"
else
  read -p "Enter your token (available at elenabenoit.com): " TOKEN
fi

if [ -z "$TOKEN" ]; then
  echo "❌ Missing token. Installation cancelled."
  echo "   → Get your token at elenabenoit.com"
  exit 1
fi

echo ""
echo "Installing..."

# Créer les dossiers PayWait
mkdir -m 700 -p ~/.paywait
mkdir -m 700 -p ~/.paywait/antigravity
mkdir -m 700 -p ~/.paywait/opencode

# Télécharger les fichiers depuis GitHub (pas de dépendance à une copie locale de extension/)
curl -sSL "$BASE_URL/claude-code/statusline.mjs" -o ~/.paywait/statusline.mjs
curl -sSL "$BASE_URL/antigravity/statusline.mjs" -o ~/.paywait/antigravity/statusline.mjs
curl -sSL "$BASE_URL/antigravity/install-antigravity.mjs" -o ~/.paywait/antigravity/install-antigravity.mjs
curl -sSL "$BASE_URL/antigravity/uninstall-antigravity.mjs" -o ~/.paywait/antigravity/uninstall-antigravity.mjs
curl -sSL "$BASE_URL/antigravity/local-files.mjs" -o ~/.paywait/antigravity/local-files.mjs
curl -sSL "$BASE_URL/antigravity/refresh-worker.mjs" -o ~/.paywait/antigravity/refresh-worker.mjs
curl -sSL "$BASE_URL/opencode/dist/tui.js" -o ~/.paywait/opencode/tui.js
curl -sSL "$BASE_URL/opencode/scripts/install-opencode.mjs" -o ~/.paywait/opencode/install-opencode.mjs
curl -sSL "$BASE_URL/opencode/scripts/uninstall-opencode.mjs" -o ~/.paywait/opencode/uninstall-opencode.mjs
curl -sSL "$BASE_URL/opencode/package.json" -o ~/.paywait/opencode/package.json

# Sauvegarder le token
echo "{\"token\": \"$TOKEN\", \"backend\": \"https://elenabenoit.com/api\"}" > ~/.paywait/config.json
chmod 600 ~/.paywait/config.json

# Sauvegarder le settings.json existant une seule fois : ne jamais écraser
# une sauvegarde déjà présente, y compris si PayWait est déjà installé
# (sinon une réinstallation capturerait l'état PayWait comme "original").
SETTINGS="$HOME/.claude/settings.json"
BACKUP="$HOME/.claude/settings.json.paywait-backup"
if [ -f "$SETTINGS" ] && [ ! -f "$BACKUP" ]; then
  cp "$SETTINGS" "$BACKUP"
fi

# Mettre à jour settings.json Claude Code
node -e "
const fs = require('fs');
const path = '$SETTINGS';
const s = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
s.statusLine = {
  type: 'command',
  command: 'node ' + process.env.HOME + '/.paywait/statusline.mjs',
  refreshInterval: 10
};
fs.writeFileSync(path, JSON.stringify(s, null, 2));
"

# Installer le plugin TUI OpenCode indépendamment lorsque l'outil est présent.
if command -v opencode >/dev/null 2>&1; then
  node ~/.paywait/opencode/install-opencode.mjs || true
fi

# Installer la statusline Antigravity sans affecter Claude Code ou OpenCode.
if command -v agy >/dev/null 2>&1; then
  node ~/.paywait/antigravity/install-antigravity.mjs || true
fi

echo ""
echo "✅ PayWait installed successfully!"
echo "🎉 You'll start earning on your next prompt."
echo ""
