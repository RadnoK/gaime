#!/bin/sh
# Copy the checkpoint of one game (atomic file, always complete) and keep N days.
#   backup.sh /srv/gaime/<game> [days=3]
set -eu
umask 077
base=${1:?game directory, e.g. /srv/gaime/starter}
days=${2:-3}
test -f "$base/data/checkpoint.json" || exit 0
mkdir -p "$base/backups"
cp "$base/data/checkpoint.json" "$base/backups/checkpoint-$(date -u +%Y%m%dT%H%M%SZ).json"
find "$base/backups" -maxdepth 1 -type f -name 'checkpoint-*.json' -mmin +$((days * 1440)) -delete
