#!/usr/bin/env bash
# ftscope lab: boot the host kernel in a throwaway KVM guest and capture real ftrace output.
# Needs Docker and /dev/kvm. Usage: ./lab/run.sh   (KERNEL=/path/to/bzImage to override)
#
#   ./lab/run.sh              run every experiment; refresh lab/out and examples/traces
#   ./lab/run.sh record-test  only try tools/ftscope-record in the guest; results in lab/out-record-test
set -euo pipefail
LAB=$(cd "$(dirname "$0")" && pwd)
KERNEL=${KERNEL:-/boot/vmlinuz-linux}
NAME=ftscope-lab-$$
ONLY=${1:-}
if [ -n "$ONLY" ]; then SCRIPT=guest/$ONLY.sh; OUT=out-$ONLY; else SCRIPT=guest/experiments.sh; OUT=out; fi
[ -f "$LAB/$SCRIPT" ] || { echo "no such experiment script: lab/$SCRIPT" >&2; exit 2; }
trap 'docker kill "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM

docker build -q -t ftscope-lab "$LAB" >/dev/null
rm -rf "$LAB/$OUT" "$LAB/build" && mkdir -p "$LAB/build"
cp "$KERNEL" "$LAB/build/vmlinuz"
cp "$LAB/../tools/ftscope-record" "$LAB/build/ftscope-record"
docker run --rm --name "$NAME" --device /dev/kvm --user "$(id -u):$(id -g)" \
	-v "$LAB:/lab" -e VM_TIMEOUT="${VM_TIMEOUT:-1500}" -e SCRIPT="$SCRIPT" -e OUT="$OUT" ftscope-lab sh /lab/inside.sh

if [ -n "$ONLY" ]; then
	[ -n "$(ls -A "$LAB/$OUT" 2>/dev/null)" ] || { echo "no results; see lab/build/console.log" >&2; exit 1; }
	echo "results: lab/$OUT/"
	exit 0
fi
[ -f "$LAB/out/overhead.csv" ] || { echo "no results; see lab/build/console.log" >&2; exit 1; }
"$LAB/curate.sh"
echo "raw results: lab/out/   curated: examples/traces/"
