#!/bin/bash

BASE_URL="https://raw.githubusercontent.com/Benoitprrn/paywait-extension/main"

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║        Uninstalling PayWait           ║"
echo "╚═══════════════════════════════════════╝"
echo ""
SKIP_CONFIRM=false
if [ "$1" = "--yes" ] || [ "$1" = "-y" ]; then
  SKIP_CONFIRM=true
fi
if [ "$SKIP_CONFIRM" = false ]; then
  read -p "Are you sure you want to uninstall PayWait? (y/n): " CONFIRM
  if [ "$CONFIRM" != "y" ]; then
    echo "Uninstallation cancelled."
    exit 0
  fi
fi

echo ""
echo "Uninstalling..."

# Restaurer uniquement la statusline Antigravity installée par PayWait. Cette
# étape précède la suppression de ~/.paywait car elle contient la sauvegarde.
# Téléchargé à chaque fois (uninstall.sh n'est pas copié dans ~/.paywait par
# install.sh, et peut être exécuté seul via curl | bash sans le reste de
# extension/) : on ne peut pas compter sur un fichier voisin de $0.
mkdir -m 700 -p ~/.paywait/antigravity
curl -sSL "$BASE_URL/antigravity/uninstall-antigravity.mjs" -o ~/.paywait/antigravity/uninstall-antigravity.mjs
curl -sSL "$BASE_URL/antigravity/local-files.mjs" -o ~/.paywait/antigravity/local-files.mjs
node ~/.paywait/antigravity/uninstall-antigravity.mjs || true

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
echo "👋 See you on paywait-ads.com"
echo ""
