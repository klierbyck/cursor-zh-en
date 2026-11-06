#!/bin/sh
set -eu
exec sh "$(dirname -- "$0")/scripts/localize-mac.sh" restore "$@"
