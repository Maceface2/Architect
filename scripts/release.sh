#!/usr/bin/env bash
# Release helper for Architect. Bumps version, builds + signs + notarizes,
# publishes to Maceface2/Architect-releases, then tags the source commit.
#
# Usage:
#   scripts/release.sh <version> [release-note]
#
# Examples:
#   scripts/release.sh 0.1.1-alpha "Pilot fix: zone PTY race"
#   scripts/release.sh 0.2.0       "First stable pilot"

set -euo pipefail

VERSION="${1:-}"
NOTE="${2:-Release v${VERSION}}"

if [[ -z "$VERSION" ]]; then
  echo "usage: scripts/release.sh <version> [release-note]" >&2
  exit 2
fi

# Loose semver gate: MAJOR.MINOR.PATCH with optional -prerelease.N segments.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' is not a valid semver string" >&2
  exit 2
fi

TAG="v${VERSION}"

# Run from repo root no matter where the user invoked the script.
cd "$(dirname "$0")/.."

echo "==> preflight checks"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "error: GH_TOKEN is unset. open a new shell or run: export GH_TOKEN=\$(gh auth token)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty. commit or stash before releasing." >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "warning: releasing from branch '$CURRENT_BRANCH', not 'main'."
  read -r -p "continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists locally. pick a new version." >&2
  exit 1
fi

if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  echo "error: tag $TAG already exists on origin. pick a new version." >&2
  exit 1
fi

# The keychain notarization profile ('architect-notary' per package.json) can't
# be reliably probed via `security` — notarytool stores it in a non-standard slot.
# If the profile is missing or invalid, electron-builder will surface that during
# the notarize step rather than as a preflight error.

CURRENT_VERSION="$(node -p "require('./package.json').version")"

if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  echo "==> package.json already at $VERSION, skipping bump"
  COMMIT_CREATED=0
else
  echo "==> bumping package.json $CURRENT_VERSION -> $VERSION"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    p.version = process.argv[1];
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  " "$VERSION"
  git add package.json
  git commit -m "release: v${VERSION}

${NOTE}"
  COMMIT_CREATED=1
fi

echo "==> building, signing, notarizing, publishing to Maceface2/Architect-releases"
echo "    (this takes 8-15 minutes, mostly Apple notarization)"
# electron-builder 25 reads notarytool credentials from env vars, not package.json.
# APPLE_KEYCHAIN_PROFILE points at the entry created via `notarytool store-credentials`.
export APPLE_KEYCHAIN_PROFILE="architect-notary"
if ! npm run release; then
  echo ""
  echo "error: npm run release failed." >&2
  if [[ "$COMMIT_CREATED" == "1" ]]; then
    echo "       rolling back the version-bump commit." >&2
    git reset --hard HEAD~1
  fi
  exit 1
fi

echo "==> tagging $TAG"
git tag -a "$TAG" -m "$NOTE"

echo "==> pushing commit + tag to origin"
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo ""
echo "==> released v${VERSION}"
echo "    https://github.com/Maceface2/Architect-releases/releases/tag/${TAG}"
