#!/usr/bin/env bash
# update-dashboard.sh — Fetches latest commit counts and dates from GitHub API,
# updates data.json in the project-dashboard repo, and pushes it.
# Runs inside GitHub Actions (production-monitor) with GH_TOKEN.

set -euo pipefail

OWNER="Arivioo"
DASHBOARD_REPO="project-dashboard"

# Fetch current data.json from the dashboard repo
echo "Fetching current data.json..."
DATA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" \
  --jq '.content' | base64 -d)

# Get the SHA of the current file (needed for the update API call)
FILE_SHA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" --jq '.sha')

# Extract repo names from data.json (products + tools that have a "repo" field)
REPOS=$(echo "$DATA" | jq -r '(.products + .tools) | .[] | select(.repo) | .repo')

UPDATED_DATA="$DATA"
CHANGES=0

for REPO in $REPOS; do
  echo "Checking ${REPO}..."

  # Get default branch
  BRANCH=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .branch // "main"')

  # Get commit count via contributors API (sum all contributions)
  COMMIT_COUNT=$(gh api "repos/${OWNER}/${REPO}/contributors" \
    --jq '[.[].contributions] | add // 0' 2>/dev/null || echo "0")

  # Get last commit date
  LAST_COMMIT_DATE=$(gh api "repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=1" \
    --jq '.[0].commit.committer.date' 2>/dev/null || echo "")

  if [ -z "$LAST_COMMIT_DATE" ] || [ "$COMMIT_COUNT" = "0" ]; then
    echo "  Skipping ${REPO} (no data)"
    continue
  fi

  # Format date as "D Mon" (e.g., "4 May")
  FORMATTED_DATE=$(date -d "$LAST_COMMIT_DATE" '+%-d %b' 2>/dev/null || \
    date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_COMMIT_DATE" '+%-d %b' 2>/dev/null || echo "")

  if [ -z "$FORMATTED_DATE" ]; then
    echo "  Could not parse date for ${REPO}"
    continue
  fi

  # Get current values from data.json
  CURRENT_COMMITS=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .commits')

  if [ "$COMMIT_COUNT" != "$CURRENT_COMMITS" ]; then
    echo "  ${REPO}: ${CURRENT_COMMITS} -> ${COMMIT_COUNT} commits, last active: ${FORMATTED_DATE}"
    CHANGES=$((CHANGES + 1))
  else
    echo "  ${REPO}: ${CURRENT_COMMITS} commits (unchanged), last active: ${FORMATTED_DATE}"
  fi

  # Always update lastActive date (even if commits unchanged, date format may differ)
  UPDATED_DATA=$(echo "$UPDATED_DATA" | jq --arg r "$REPO" \
    --argjson c "$COMMIT_COUNT" --arg d "$FORMATTED_DATE" \
    '.products |= map(if .repo == $r then .commits = $c | .lastActive = $d else . end) |
     .tools |= map(if .repo == $r then .commits = $c | .lastActive = $d else . end)')
done

# Update the lastUpdated field
TODAY=$(date '+%-d %b %Y')
UPDATED_DATA=$(echo "$UPDATED_DATA" | jq --arg d "$TODAY" '.lastUpdated = $d')

echo ""
echo "Updating data.json (${CHANGES} commit changes)..."

# Encode updated data as base64
ENCODED=$(echo "$UPDATED_DATA" | jq '.' | base64 -w 0)

# Push updated data.json to the dashboard repo via GitHub API
gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" \
  --method PUT \
  --field message="chore: daily auto-update project stats (${TODAY})" \
  --field content="$ENCODED" \
  --field sha="$FILE_SHA" \
  --field branch="main" \
  > /dev/null

echo "data.json updated in repo."

# Also FTP data.json directly to the live site (avoids triggering private repo CI minutes)
if [ -n "${FTP_HOST:-}" ] && [ -n "${FTP_USER:-}" ] && [ -n "${FTP_PASS:-}" ]; then
  echo "Deploying data.json to projects.predivo.ch via FTP..."
  echo "$UPDATED_DATA" | jq '.' > /tmp/data.json
  curl -s -T /tmp/data.json "ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}/projects.predivo.ch/data.json"
  echo "FTP upload complete."
  rm -f /tmp/data.json
fi

echo "Done."
