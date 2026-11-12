#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then printf '%s\n' 'Usage: scripts/package-release.sh VERSION OUTPUT_DIRECTORY' >&2; exit 2; fi
VERSION=$1
case "$VERSION" in *[!0-9.]*|.*|*.|*..*|'') printf '%s\n' 'Use a numeric version such as 0.1.0.' >&2; exit 2;; esac
if [ "$(printf '%s' "$VERSION" | tr -cd '.' | wc -c | tr -d ' ')" -ne 2 ]; then printf '%s\n' 'Use a numeric version such as 0.1.0.' >&2; exit 2; fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p -- "$2"
OUTPUT=$(CDPATH= cd -- "$2" && pwd)
NAME="local-deploy-$VERSION.tar.gz"
if [ -e "$OUTPUT/$NAME" ] || [ -e "$OUTPUT/$NAME.sha256" ]; then printf '%s\n' 'Release file already exists; choose another output directory or version.' >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then HASH=sha256sum
elif command -v shasum >/dev/null 2>&1; then HASH=shasum
else printf '%s\n' 'sha256sum or shasum is required.' >&2; exit 1
fi
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/local-deploy-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
mkdir -p "$STAGE/local-service/dashboard" "$STAGE/cloud"
cp "$ROOT/start.sh" "$STAGE/start.sh"
for f in README.md artifacts.mjs jobs.mjs repository.mjs security.mjs server.mjs worker.mjs worker.Dockerfile worker-proxy.mjs worker-validate.cjs; do cp "$ROOT/local-service/$f" "$STAGE/local-service/$f"; done
for f in index.html app.js style.css; do cp "$ROOT/local-service/dashboard/$f" "$STAGE/local-service/dashboard/$f"; done
for f in README.md hosting.yaml publish.mjs; do cp "$ROOT/cloud/$f" "$STAGE/cloud/$f"; done
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
tar -C "$STAGE" -czf "$OUTPUT/$NAME" VERSION start.sh local-service cloud
if [ "$HASH" = sha256sum ]; then (cd "$OUTPUT" && sha256sum "$NAME" > "$NAME.sha256")
else (cd "$OUTPUT" && shasum -a 256 "$NAME" > "$NAME.sha256")
fi
printf 'Created %s and %s.sha256\n' "$OUTPUT/$NAME" "$OUTPUT/$NAME"
