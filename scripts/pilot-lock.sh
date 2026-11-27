#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || "$1" != /* ]]; then
  echo 'Expected an absolute Donefac data directory and a command.' >&2
  exit 64
fi

data_dir=$(realpath -m -- "$1")
shift
if [[ "$data_dir" == / || ! -d "$(dirname -- "$data_dir")" ]]; then
  echo 'The parent of the Donefac data directory must exist.' >&2
  exit 64
fi

# Settings written before the product rename use the TEAMSPACE_ prefix; keep honoring them.
while IFS= read -r legacy_name; do
  current_name="DONEFAC_${legacy_name#TEAMSPACE_}"
  [[ -v "$current_name" ]] || export "$current_name=${!legacy_name}"
done < <(compgen -e | grep '^TEAMSPACE_' || true)

umask 077
lock_file="${data_dir}.donefac.lock"
if [[ -L "$lock_file" || ( -e "$lock_file" && ! -f "$lock_file" ) ]]; then
  echo 'The Donefac lock path must be a regular file.' >&2
  exit 64
fi
exec 9>>"$lock_file"
if ! flock --exclusive --nonblock 9; then
  echo 'Another Donefac pilot process or backup operation holds the data lock.' >&2
  exit 75
fi

export DONEFAC_DATA_DIR="$data_dir"
export DONEFAC_PILOT_LOCKED_DIR="$data_dir"
export DONEFAC_PILOT_LOCK_FD=9
exec "$@"
