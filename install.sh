#!/usr/bin/env sh
set -eu

REPO="Fearless743/new-api-auto-register"
BRANCH="main"
INSTALL_DIR="${INSTALL_DIR:-/opt/new-api-auto-register}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

fetch() {
  url="$1"
  output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  wget -qO "$output" "$url"
}

need_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "curl or wget is required" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR/data"

fetch "$RAW_BASE/compose.yaml" "$INSTALL_DIR/compose.yaml"
fetch "$RAW_BASE/.env.example" "$INSTALL_DIR/.env.example"

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo "Created $INSTALL_DIR/.env from template. Please fill in the required values before first successful run."
fi

if [ ! -f "$INSTALL_DIR/data/store.json" ]; then
  cat > "$INSTALL_DIR/data/store.json" <<'EOF'
{
  "accounts": [],
  "checkins": [],
  "balanceSnapshot": {
    "updatedAt": null,
    "totalQuota": 0,
    "totalBalance": "$0.00",
    "accounts": []
  },
  "metadata": {
    "version": 1,
    "createdAt": null,
    "updatedAt": null
  }
}
EOF
fi

touch "$INSTALL_DIR/data/tokens.txt" "$INSTALL_DIR/data/tokens.csv"

docker compose -f "$INSTALL_DIR/compose.yaml" --env-file "$INSTALL_DIR/.env" pull
docker compose -f "$INSTALL_DIR/compose.yaml" --env-file "$INSTALL_DIR/.env" up -d

echo "Installed to $INSTALL_DIR"
echo "API endpoint: http://<server-ip>:3000/api/balances"
echo "Edit $INSTALL_DIR/.env and $INSTALL_DIR/data/store.json as needed, then run:"
echo "docker compose -f $INSTALL_DIR/compose.yaml --env-file $INSTALL_DIR/.env restart"
