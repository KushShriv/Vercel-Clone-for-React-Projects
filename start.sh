#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 20 or newer is required. Install it, then run this launcher again.' >&2
  exit 1
fi
NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
case "$NODE_MAJOR" in ''|*[!0-9]*) printf '%s\n' 'Could not determine the Node.js version.' >&2; exit 1;; esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '%s\n' 'Node.js 20 or newer is required.' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 && [ -x "${HOME:-}/Applications/Docker.app/Contents/Resources/bin/docker" ]; then
  PATH="${HOME}/Applications/Docker.app/Contents/Resources/bin:$PATH"
  export PATH
fi
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker is required. Install and start Docker, then run this launcher again.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker is not available. Start Docker and verify that your account can use it.' >&2
  exit 1
fi
printf '%s\n' 'Builds consume disk space, CPU and network bandwidth. Press Ctrl-C to stop the local service.'
exec node "$ROOT/local-service/server.mjs"
