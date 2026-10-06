#!/bin/sh
# Summarise overhead.csv and copy the curated traces from lab/out to examples/traces.
set -eu
LAB=$(cd "$(dirname "$0")" && pwd); OUT=$LAB/out; EX=$LAB/../examples/traces
# medians/min/max per config -> overhead.json
for c in $(tail -n +2 $OUT/overhead.csv | cut -d, -f1 | uniq); do
	for col in 3 4; do grep "^$c," $OUT/overhead.csv | cut -d, -f$col | sort -n | tr '\n' ' '; echo; done |
	awk -v c="$c" '{ n=split($0,a," "); s[NR]=sprintf("{\"median\":%s,\"min\":%s,\"max\":%s,\"runs\":[%s]}", a[int((n+1)/2)], a[1], a[n], gensub_join(a,n)) }
		function gensub_join(a,n,  r,i){ r=a[1]; for(i=2;i<=n;i++) r=r "," a[i]; return r }
		END { printf "  \"%s\": {\"getppid_ns\": %s, \"read_1byte_devzero_ns\": %s}", c, s[1], s[2] }'
	echo ","
done | sed '$ s/,$//' | { echo "{"; cat; echo "}"; } > $OUT/overhead.json
mkdir -p $EX
find $EX -maxdepth 1 -type f ! -name README.md -delete
for f in $OUT/*.trace $OUT/*.cmds $OUT/*.txt $OUT/*.csv $OUT/*.json $OUT/01-nop-patching.enabled_functions.b; do
	case $f in *04-big*) continue;; esac
	cp "$f" $EX/
done
cp -r $OUT/00-env $EX/
