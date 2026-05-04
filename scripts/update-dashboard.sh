#!/usr/bin/env bash
# update-dashboard.sh — Fetches latest commit counts and dates from GitHub API,
# updates data.json + changelog.json in the project-dashboard repo.
# Runs inside GitHub Actions (production-monitor) with GH_TOKEN.

set -euo pipefail

OWNER="Arivioo"
DASHBOARD_REPO="project-dashboard"

# Fetch current data.json from the dashboard repo
echo "Fetching current data.json..."
DATA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" \
  --jq '.content' | base64 -d)
DATA_SHA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" --jq '.sha')

# Fetch current changelog.json
echo "Fetching current changelog.json..."
CHANGELOG=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
  --jq '.content' | base64 -d 2>/dev/null || echo "[]")
CHANGELOG_SHA=$(gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
  --jq '.sha' 2>/dev/null || echo "")

# Extract repo names from data.json (products + tools that have a "repo" field)
REPOS=$(echo "$DATA" | jq -r '(.products + .tools) | .[] | select(.repo) | .repo')

UPDATED_DATA="$DATA"
CHANGES=0
# Build changelog changes array as JSON
CHANGELOG_CHANGES="[]"

for REPO in $REPOS; do
  echo "Checking ${REPO}..."

  # Get default branch
  BRANCH=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .branch // "main"')

  # Get project display name
  PROJ_NAME=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .name')

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

  # Format date as "D Mon" (e.g., "4 May") — handle both Z and +00:00 timezone formats
  CLEAN_DATE=$(echo "$LAST_COMMIT_DATE" | sed 's/+00:00$/Z/' | sed 's/T/ /' | sed 's/Z$//')
  FORMATTED_DATE=$(date -d "$CLEAN_DATE" '+%-d %b' 2>/dev/null || \
    date -d "$LAST_COMMIT_DATE" '+%-d %b' 2>/dev/null || echo "")

  if [ -z "$FORMATTED_DATE" ]; then
    echo "  Could not parse date for ${REPO}"
    continue
  fi

  # Get current values from data.json
  CURRENT_COMMITS=$(echo "$DATA" | jq -r --arg r "$REPO" \
    '(.products + .tools)[] | select(.repo == $r) | .commits')

  if [ "$COMMIT_COUNT" != "$CURRENT_COMMITS" ]; then
    NEW_COMMITS=$((COMMIT_COUNT - CURRENT_COMMITS))
    echo "  ${REPO}: ${CURRENT_COMMITS} -> ${COMMIT_COUNT} commits (+${NEW_COMMITS}), last active: ${FORMATTED_DATE}"
    CHANGES=$((CHANGES + 1))

    # Fetch recent commit messages (up to 5 or the delta, whichever is smaller)
    FETCH_COUNT=5
    if [ "$NEW_COMMITS" -gt 0 ] && [ "$NEW_COMMITS" -lt 5 ]; then
      FETCH_COUNT=$NEW_COMMITS
    fi

    MESSAGES=$(gh api "repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=${FETCH_COUNT}" \
      --jq '[.[] | .commit.message | split("\n")[0] | if length > 80 then .[:77] + "..." else . end]' \
      2>/dev/null || echo "[]")

    # Add to changelog changes
    CHANGELOG_CHANGES=$(echo "$CHANGELOG_CHANGES" | jq \
      --arg name "$PROJ_NAME" \
      --arg repo "$REPO" \
      --argjson before "$CURRENT_COMMITS" \
      --argjson after "$COMMIT_COUNT" \
      --argjson delta "$NEW_COMMITS" \
      --argjson msgs "$MESSAGES" \
      '. + [{name: $name, repo: $repo, before: $before, after: $after, delta: $delta, messages: $msgs}]')
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
TODAY_ISO=$(date '+%Y-%m-%d')
UPDATED_DATA=$(echo "$UPDATED_DATA" | jq --arg d "$TODAY" '.lastUpdated = $d')

# --- Build changelog entry ---
TOTAL_NEW_COMMITS=$(echo "$CHANGELOG_CHANGES" | jq '[.[].delta] | add // 0')
PROJECTS_WORKED_ON=$(echo "$CHANGELOG_CHANGES" | jq 'length')

# Only add a changelog entry if there were actual changes
if [ "$CHANGES" -gt 0 ]; then
  echo ""
  echo "Building changelog entry: ${PROJECTS_WORKED_ON} projects, ${TOTAL_NEW_COMMITS} new commits..."

  NEW_ENTRY=$(jq -n \
    --arg date "$TODAY" \
    --arg iso "$TODAY_ISO" \
    --argjson totalNew "$TOTAL_NEW_COMMITS" \
    --argjson projCount "$PROJECTS_WORKED_ON" \
    --argjson changes "$CHANGELOG_CHANGES" \
    '{date: $date, iso: $iso, totalNewCommits: $totalNew, projectsWorkedOn: $projCount, changes: $changes}')

  # Prepend to changelog (newest first), keep last 90 days
  CHANGELOG=$(echo "$CHANGELOG" | jq --argjson entry "$NEW_ENTRY" \
    '[$entry] + . | .[0:90]')
fi

# --- Push data.json ---
echo ""
echo "Updating data.json (${CHANGES} commit changes)..."
ENCODED_DATA=$(echo "$UPDATED_DATA" | jq '.' | base64 -w 0)

gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/data.json" \
  --method PUT \
  --field message="chore: daily auto-update project stats (${TODAY})" \
  --field content="$ENCODED_DATA" \
  --field sha="$DATA_SHA" \
  --field branch="main" \
  > /dev/null

echo "data.json updated in repo."

# --- Push changelog.json ---
if [ "$CHANGES" -gt 0 ]; then
  echo "Updating changelog.json..."
  ENCODED_CHANGELOG=$(echo "$CHANGELOG" | jq '.' | base64 -w 0)

  if [ -n "$CHANGELOG_SHA" ]; then
    gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
      --method PUT \
      --field message="chore: daily changelog (${TODAY})" \
      --field content="$ENCODED_CHANGELOG" \
      --field sha="$CHANGELOG_SHA" \
      --field branch="main" \
      > /dev/null
  else
    gh api "repos/${OWNER}/${DASHBOARD_REPO}/contents/changelog.json" \
      --method PUT \
      --field message="chore: daily changelog (${TODAY})" \
      --field content="$ENCODED_CHANGELOG" \
      --field branch="main" \
      > /dev/null
  fi
  echo "changelog.json updated."
fi

# --- FTP deploy both files ---
if [ -n "${FTP_HOST:-}" ] && [ -n "${FTP_USER:-}" ] && [ -n "${FTP_PASS:-}" ]; then
  echo "Deploying to projects.predivo.ch via FTP..."
  echo "$UPDATED_DATA" | jq '.' > /tmp/data.json
  echo "$CHANGELOG" | jq '.' > /tmp/changelog.json
  curl -s -T /tmp/data.json "ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}/projects.predivo.ch/data.json"
  curl -s -T /tmp/changelog.json "ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}/projects.predivo.ch/changelog.json"
  echo "FTP upload complete."
  rm -f /tmp/data.json /tmp/changelog.json
fi

echo "Done."
