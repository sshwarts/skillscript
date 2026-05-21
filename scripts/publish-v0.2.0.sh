#!/usr/bin/env bash
# One-shot publish helper for v0.2.0. Run AFTER `npm login`.
#
# Verifies: npm auth, package.json version, git tree clean, tag present.
# Then runs `pnpm publish` (auto-fires prepublishOnly = build + loc-check + test).
#
# Re-runnable: bails cleanly on each precondition with a clear message.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Checking npm auth..."
if ! pnpm whoami > /dev/null 2>&1; then
  echo "✗ Not logged in to npm. Run 'npm login' first (interactive — needs OTP), then re-run this script."
  exit 1
fi
echo "  ok: logged in as $(pnpm whoami)"

EXPECTED_VERSION="0.2.0"
ACTUAL_VERSION=$(node -p "require('./package.json').version")
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "✗ package.json version mismatch: expected $EXPECTED_VERSION, got $ACTUAL_VERSION"
  exit 1
fi
echo "  ok: package.json on v$ACTUAL_VERSION"

if ! git diff-index --quiet HEAD --; then
  echo "✗ Working tree dirty. Commit or stash before publishing."
  exit 1
fi
echo "  ok: working tree clean"

if ! git rev-parse "v$EXPECTED_VERSION" > /dev/null 2>&1; then
  echo "✗ Tag v$EXPECTED_VERSION missing locally. Tag and push first."
  exit 1
fi
echo "  ok: tag v$EXPECTED_VERSION present"

echo
echo "→ Running pnpm publish (prepublishOnly will run build + loc-check + test)..."
echo
pnpm publish --access public

echo
echo "✓ Published. Verify at https://www.npmjs.com/package/skillscript-runtime"
