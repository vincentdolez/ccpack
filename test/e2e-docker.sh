#!/usr/bin/env bash
# End-to-end run on a fresh Linux "colleague" with the real claude CLI:
# install (both modes) → connect → verify → uninstall, then checks nothing is left.
#
#   test/e2e-docker.sh <package.tar.gz> <git repo of the project>
#
# With CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY set, verify also runs live.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO=$(cd "$2" && pwd)
VERSION=$(claude --version 2>/dev/null | cut -d' ' -f1 || echo latest)
LIVE=$([ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] && echo --live || true)

(cd "$HERE/.." && npm run --silent build && npm pack --silent --pack-destination "$HERE/docker" >/dev/null)
docker build -q -t ccpack-e2e --build-arg CLAUDE_VERSION="$VERSION" "$HERE/docker" >/dev/null
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN -e ANTHROPIC_API_KEY \
  -v "$PKG":/in/pkg.tar.gz:ro -v "$REPO":/in/repo:ro -v "$HERE/docker":/in/ccpack:ro \
  --user root ccpack-e2e bash -euo pipefail -c '
  npm install -g --silent /in/ccpack/ccpack-*.tgz
  su node -c "
    set -euo pipefail
    for mode in project user; do
      echo \"== \$mode mode\"
      git clone -q /in/repo ~/\$mode/project && cd ~/\$mode/project
      ccpack install /in/pkg.tar.gz . --mode \$mode --yes | grep -E \"✗\" || true
      ccpack connect . --yes >/dev/null
      ccpack verify . '"$LIVE"' --yes
      ccpack uninstall . --yes >/dev/null
      left=\$(git status --porcelain --ignored | wc -l)
      echo \"  leftover paths in project: \$left\"; [ \"\$left\" = 0 ]
    done
    test ! -s ~/.claude/CLAUDE.md || ! grep -q ccpack:begin ~/.claude/CLAUDE.md
    echo OK
  "'
rm -f "$HERE"/docker/ccpack-*.tgz
