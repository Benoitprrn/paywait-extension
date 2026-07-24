#!/bin/bash

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║        Uninstalling PayWait           ║"
echo "╚═══════════════════════════════════════╝"
echo ""
read -p "Are you sure you want to uninstall PayWait? (y/n): " CONFIRM

if [ "$CONFIRM" != "y" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo ""
echo "Uninstalling..."

# Restaurer uniquement la statusline Antigravity installée par PayWait. Cette
# étape précède la suppression de ~/.paywait car elle contient la sauvegarde.
node "$(dirname "$0")/antigravity/uninstall-antigravity.mjs" || true

# Restaurer le backup settings.json si existant
SETTINGS="$HOME/.claude/settings.json"
BACKUP="$HOME/.claude/settings.json.paywait-backup"

if [ -f "$BACKUP" ]; then
  cp "$BACKUP" "$SETTINGS"
  rm "$BACKUP"
else
  # Sinon supprimer juste statusLine
  node -e "
const fs = require('fs');
const path = '$SETTINGS';
if (fs.existsSync(path)) {
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
  delete s.statusLine;
  fs.writeFileSync(path, JSON.stringify(s, null, 2));
}
"
fi

# Supprimer le dossier PayWait
rm -rf ~/.paywait

echo ""
echo "✅ PayWait uninstalled successfully."
echo "👋 See you on elenabenoit.com"
echo ""
