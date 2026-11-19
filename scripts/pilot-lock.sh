#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || "$1" != /* ]]; then
  echo 'Expected an absolute Teamspace data directory and a command.' >&2
  exit 64
fi

data_dir=$(realpath -m -- "$1")
shift
if [[ "$data_dir" == / || ! -d "$(dirname -- "$data_dir")" ]]; then
  echo 'The parent of the Teamspace data directory must exist.' >&2
  exit 64
fi

umask 077
lock_file="${data_dir}.teamspace.lock"
if [[ -L "$lock_file" || ( -e "$lock_file" && ! -f "$lock_file" ) ]]; then
  echo 'The Teamspace lock path must be a regular file.' >&2
  exit 64
fi
exec 9>>"$lock_file"
if ! flock --exclusive --nonblock 9; then
  echo 'Another Teamspace pilot process or backup operation holds the data lock.' >&2
  exit 75
fi

export TEAMSPACE_DATA_DIR="$data_dir"
export TEAMSPACE_PILOT_LOCKED_DIR="$data_dir"
export TEAMSPACE_PILOT_LOCK_FD=9
exec "$@"
