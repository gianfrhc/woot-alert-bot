#!/bin/bash
# DOCKER-02: Initialize data directory with required files before docker-compose up
# Run this ONCE before first deployment: bash docker-init.sh

DATA_DIR="./data"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/logs"

# Create empty JSON files if they don't exist (prevents Docker from creating them as directories)
for file in auth.json settings.json sessions.json ntfy-logs.json seen-ids.json; do
  if [ ! -f "$DATA_DIR/$file" ]; then
    if [ "$file" = "ntfy-logs.json" ] || [ "$file" = "seen-ids.json" ]; then
      echo "[]" > "$DATA_DIR/$file"
    else
      echo "{}" > "$DATA_DIR/$file"
    fi
    echo "  ✓ Created $DATA_DIR/$file"
  else
    echo "  • $DATA_DIR/$file already exists"
  fi
done

echo ""
echo "  Data directory initialized. Run: docker compose up -d --build"
