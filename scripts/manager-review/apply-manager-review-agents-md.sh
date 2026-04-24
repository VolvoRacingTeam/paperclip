#!/usr/bin/env bash
# Apply "Manager review mode" section to the 4 manager AGENTS.md files.
# Runs against the live paperclip data volume inside LXC 100. Idempotent:
# skips if the marker comment is already present.
#
# Usage (inside LXC 100):
#   bash scripts/manager-review/apply-manager-review-agents-md.sh [--dry-run]
#
# Safety: does NOT set requires_manager_review on workers, does NOT unpause
# managers, does NOT restart containers. Only prepends documentation text.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# Manager UUIDs (Verkvelven AS company 10ca8f03-1f23-4d63-a350-b6d0664ef5a4).
# Looked up via:
#   SELECT id, name FROM agents WHERE name IN
#   ('Regnskapsleder','Kundeleder','Driftleder','Kunnskapsleder');
MANAGER_IDS=(
  "43ee8a10-0dee-4ff2-87ac-d461e43123e2"  # Regnskapsleder
  "eab79fd8-b4c4-4554-8604-f14ccea7ce97"  # Kundeleder
  "6b2fc39b-a9cc-4031-83b4-c26d210639a4"  # Driftleder
  "e7d9da5e-c345-4a8a-83a5-64852c9685aa"  # Kunnskapsleder
)

VOLUME_ROOT="/var/lib/docker/volumes/paperclip_paperclip-data/_data"
COMPANY_ID="10ca8f03-1f23-4d63-a350-b6d0664ef5a4"
BLOCK_FILE="$(dirname "$0")/manager-review-mode-section.md"
MARKER="<!-- manager-review-mode:v1 -->"

if [[ ! -f "$BLOCK_FILE" ]]; then
  echo "ERROR: block file not found: $BLOCK_FILE" >&2
  exit 1
fi

for mgr_id in "${MANAGER_IDS[@]}"; do
  agents_md="$VOLUME_ROOT/instances/default/companies/$COMPANY_ID/agents/$mgr_id/instructions/AGENTS.md"
  if [[ ! -f "$agents_md" ]]; then
    echo "SKIP: $agents_md (not found)"
    continue
  fi
  if grep -qF "$MARKER" "$agents_md"; then
    echo "SKIP: $mgr_id (marker already present)"
    continue
  fi
  echo "APPLY: $mgr_id -> $agents_md"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "(dry-run — no write)"
    continue
  fi
  tmp="$(mktemp)"
  header="$(head -n 1 "$agents_md")"
  tail -n +2 "$agents_md" > "$tmp.rest"
  {
    echo "$header"
    echo ""
    echo "$MARKER"
    cat "$BLOCK_FILE"
    echo ""
    cat "$tmp.rest"
  } > "$tmp"
  cp "$tmp" "$agents_md"
  rm -f "$tmp" "$tmp.rest"
  echo "OK: $mgr_id"
done

echo "Done."
