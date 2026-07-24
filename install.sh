#!/bin/bash

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║         Installing PayWait            ║"
echo "╚═══════════════════════════════════════╝"
echo ""
echo "Earn money while your AI codes."
echo "One ad. Every time you wait. You keep 50%."
echo ""
read -p "Enter your token (available on elenabenoit.com): " TOKEN

if [ -z "$TOKEN" ]; then
  echo ""
  echo "❌ Missing token. Installation cancelled."
  echo "   → Get your token at elenabenoit.com"
  exit 1
fi

echo ""
echo "Installing..."

# Créer le dossier PayWait
mkdir -m 700 -p ~/.paywait

# Copier le script statusline
cp "$(dirname "$0")/statusline.mjs" ~/.paywait/statusline.mjs

# Sauvegarder le token
echo "{\"token\": \"$TOKEN\", \"backend\": \"https://elenabenoit.com/api\"}" > ~/.paywait/config.json
chmod 600 ~/.paywait/config.json

# Sauvegarder le settings.json existant
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$HOME/.claude/settings.json.paywait-backup"
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
  node "$(dirname "$0")/opencode/scripts/install-opencode.mjs" || true
fi

# Installer la statusline Antigravity sans affecter Claude Code ou OpenCode.
if command -v agy >/dev/null 2>&1; then
  node "$(dirname "$0")/antigravity/install-antigravity.mjs" || true
fi

echo ""
echo "✅ PayWait installed successfully!"
echo "🎉 You'll start earning on your next prompt."
echo ""
