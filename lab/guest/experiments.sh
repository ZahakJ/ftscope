# Runs inside the VM as root. Every tracefs write goes through w(), which also logs it to
# $O/<experiment>.cmds, so each trace file has an exact record of how it was made.
T=/sys/kernel/tracing
O=/out
cd $T

w() { echo "$2" > "$1" && echo "echo '$2' > $1" >> "$O/$X.cmds"; }   # w FILE VALUE
note() { echo "# $*" >> "$O/$X.cmds"; }
has() { [ -e "$T/options/$1" ]; }

reset() {
	echo 0 > tracing_on; echo nop > current_tracer
	echo > set_ftrace_filter; echo > set_graph_function; echo > set_ftrace_pid; echo > set_event_pid
	echo 0 > events/enable; echo 0 > tracing_thresh; echo 0 > max_graph_depth
	echo 1408 > buffer_size_kb
	while read -r n v; do echo $v > options/$n; done < $O/00-env/options.default
	echo > trace
}
begin() { reset; X=$1; echo "== $X"; : > "$O/$X.cmds"; }
save() { cat trace > "$O/$X.trace"; reset; }

# Run "$@" with tracing switched on from inside the workload's own process, so the pid
# filters match it from its first instruction (sh writes its pid, then execs the workload).
traced() {
	note "workload (pid-filtered): $*"
	echo "sh -c 'echo \$\$ > set_ftrace_pid; echo \$\$ > set_event_pid; echo 1 > tracing_on; exec $*'" >> "$O/$X.cmds"
	sh -c 'echo $$ > '$T'/set_ftrace_pid; echo $$ > '$T'/set_event_pid; echo 1 > '$T'/tracing_on; exec "$@"' sh "$@" > /dev/null
	echo 0 > tracing_on; echo "echo 0 > tracing_on" >> "$O/$X.cmds"
}
# Unfiltered: tracing on, workload, tracing off.
system() { w tracing_on 1; note "workload (unfiltered): $*"; "$@" > /dev/null; w tracing_on 0; }

GRAPH_RICH="funcgraph-abstime funcgraph-proc funcgraph-cpu funcgraph-duration funcgraph-irqs funcgraph-tail"
EVENTS="sched/sched_switch sched/sched_wakeup irq/irq_handler_entry irq/irq_handler_exit irq/softirq_entry irq/softirq_exit raw_syscalls/sys_enter raw_syscalls/sys_exit"

# ---- 00: environment snapshot ------------------------------------------------------------
E=$O/00-env; mkdir -p $E
uname -a > $E/uname.txt
for f in options/*; do echo "${f#options/} $(cat $f)"; done > $E/options.default
for f in available_tracers trace_options dyn_ftrace_total_info README trace_clock buffer_size_kb \
         buffer_total_size_kb set_ftrace_notrace tracing_thresh max_graph_depth; do
	cat $f > $E/$f.txt 2>&1
done
ls -l options > $E/options-dir.txt
wc -l < available_filter_functions > $E/available_filter_functions.count
head -40 available_filter_functions > $E/available_filter_functions.head40
wc -l < available_events > $E/available_events.count
[ -e /proc/config.gz ] && zcat /proc/config.gz | grep -E 'KCORE|LOCKDOWN|FTRACE|FUNCTION_|FENTRY|CALL_PADDING|FINEIBT|CFI' > $E/config-excerpt.txt

# ---- 01: the kernel rewrites itself ------------------------------------------------------
X=01-nop-patching; reset; echo "== $X"; : > $O/$X.cmds
P="vfs_read ksys_write do_sys_openat2"
{
	echo "### (a) tracing off (current_tracer=nop)"; kpeek $P
	w set_ftrace_filter vfs_read; w current_tracer function
	echo "### (b) current_tracer=function, set_ftrace_filter=vfs_read"; kpeek $P
	cat enabled_functions > $O/$X.enabled_functions.b
	w current_tracer nop
	echo "### (c) back to current_tracer=nop"; kpeek $P
	w set_ftrace_filter ''; w current_tracer function
	echo "### (d) current_tracer=function, no filter (every traceable function)"; kpeek $P
	w current_tracer nop; w set_graph_function vfs_read; w current_tracer function_graph
	echo "### (e) current_tracer=function_graph, set_graph_function=vfs_read"; kpeek $P
	w current_tracer nop
} > $O/$X.txt 2>&1
reset

# ---- 02: function tracer ----------------------------------------------------------------
begin 02-function-default;   w current_tracer function; traced cat /proc/version; save
begin 02-function-noirqinfo; w current_tracer function; w trace_options noirq-info; traced cat /proc/version; save
begin 02-function-latency;   w current_tracer function; w trace_options latency-format; traced cat /proc/version; save
begin 02-function-noparent;  w current_tracer function; w trace_options noprint-parent; traced cat /proc/version; save

# ---- 03: function_graph, default options --------------------------------------------------
begin 03-graph-default; w current_tracer function_graph; traced cat /proc/version; save
begin 03-graph-system;  w buffer_size_kb 4096; w current_tracer function_graph
sh /bin/multitask > /dev/null & BG=$!; system usleep 80000; wait $BG; save

# ---- 04: function_graph option variants ---------------------------------------------------
g() { # g NAME OPTIONS... : one pid-filtered function_graph capture with options set
	begin 04-graph-$1; shift; w current_tracer function_graph
	for o in "$@"; do
		if has "${o#no}"; then w trace_options $o; else note "option $o NOT PRESENT in this kernel"; fi
	done
	traced cat /proc/version; save
}
g rich $GRAPH_RICH
g retval funcgraph-retval
g retval-hex funcgraph-retval funcgraph-retval-hex
g args funcgraph-args
g retaddr funcgraph-retaddr
g latency latency-format
g noirqinfo noirq-info
g bare nofuncgraph-cpu nofuncgraph-overhead nofuncgraph-duration
g everything $GRAPH_RICH funcgraph-retval funcgraph-args funcgraph-retaddr

begin 04-graph-events; w current_tracer function_graph
for o in $GRAPH_RICH function-fork event-fork; do w trace_options $o; done
for e in $EVENTS; do w events/$e/enable 1; done
traced multitask; save

begin 04-big; w buffer_size_kb 6144; w current_tracer function_graph
for o in $GRAPH_RICH funcgraph-retval; do w trace_options $o; done
for e in $EVENTS; do w events/$e/enable 1; done
system sh -c "multitask; ls -lR / > /dev/null 2>&1; multitask"; save

# ---- 05: multi-task context switches -------------------------------------------------------
for v in proc noproc; do
	begin 05-multitask-$v; w buffer_size_kb 4096; w current_tracer function_graph
	w trace_options function-fork; [ $v = proc ] && w trace_options funcgraph-proc
	traced multitask; save
done

# ---- 06: lost events, orphans ---------------------------------------------------------------
begin 06-lost-events; w buffer_size_kb 8; w current_tracer function
note "reader: cat trace_pipe > 06-lost-events.trace (concurrent with workload)"
cat trace_pipe > $O/$X.trace & R=$!
system multitask
usleep 300000; kill $R 2>/dev/null; reset

begin 06-orphans; w buffer_size_kb 64; w current_tracer function_graph
system multitask; save

# ---- 07: the mystery -------------------------------------------------------------------------
begin 07-mystery
w /sys/block/vdb/queue/read_ahead_kb 0
# fd 3 stays open throughout: the last close of a block device drops its page cache.
exec 3</dev/vdb
note "exec 3</dev/vdb  (hold the bdev open so its page cache survives between prep and run)"
note "prep (untraced): mystery prep /dev/vdb 1000"
mystery prep /dev/vdb 1000
w buffer_size_kb 16384; w current_tracer function_graph
for o in funcgraph-abstime funcgraph-proc funcgraph-retval function-fork event-fork; do w trace_options $o; done
for e in $EVENTS; do w events/$e/enable 1; done
note "workload (pid-filtered): mystery run /dev/vdb 1000 > 07-mystery.latency.csv"
sh -c 'echo $$ > '$T'/set_ftrace_pid; echo $$ > '$T'/set_event_pid; echo 1 > '$T'/tracing_on; exec mystery run /dev/vdb 1000' > $O/$X.latency.csv
w tracing_on 0; save
# Same run untraced, for the latency ground truth without tracer overhead.
mystery prep /dev/vdb 1000; mystery run /dev/vdb 1000 > $O/07-mystery.untraced-latency.csv
exec 3<&-

# ---- 08: overhead ----------------------------------------------------------------------------
X=08-overhead; : > $O/$X.cmds; echo "== $X"
CSV=$O/overhead.csv; echo "config,rep,getppid_ns,read1_ns" > $CSV
bench_cfg() { # bench_cfg NAME SETUP-COMMANDS
	reset; note "config $1: $2"; eval "$2"; echo 1 > tracing_on
	for r in 1 2 3 4 5; do echo "$1,$r,$(bench 2000000 200000 2)" >> $CSV; done
	reset
}
bench_cfg nop                   "w current_tracer nop"
bench_cfg function              "w current_tracer function"
bench_cfg function-filter1      "w set_ftrace_filter tcp_sendmsg; w current_tracer function"
bench_cfg function_graph        "w current_tracer function_graph"
bench_cfg function_graph-filter1 "w set_graph_function tcp_sendmsg; w current_tracer function_graph"
bench_cfg events-sched_switch   "w events/sched/sched_switch/enable 1"

# ---- 09: extra shapes and evidence ------------------------------------------------------------
begin 09-graph-thresh; w current_tracer function_graph; w tracing_thresh 20
system multitask; save
begin 09-graph-depth1; w current_tracer function_graph; w max_graph_depth 1; traced ls -l /bin; save
begin 09-events-only; w events/sched/sched_switch/enable 1; w events/sched/sched_wakeup/enable 1
system multitask; save
begin 09-stats; w current_tracer function; system cat /proc/version
cat per_cpu/cpu0/stats > $O/09-per_cpu-cpu0-stats.txt; reset
echo "== all experiments finished"
