#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: localize-mac.sh activate|restore [Cursor.app path]' >&2
  exit 2
fi
action=$1
if [ "$action" != activate ] && [ "$action" != restore ]; then
  echo 'Invalid action' >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
if [ ! -x node_modules/.bin/tsx ]; then
  npm ci
fi
if [ "$#" -eq 2 ]; then
  npm run cli:localize -- "$action" --install-dir "$2"
else
  npm run cli:localize -- "$action"
fi
