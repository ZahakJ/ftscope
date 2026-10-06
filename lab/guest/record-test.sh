# Runs inside the VM as root: exercise tools/ftscope-record the way its usage text says,
# and check that it leaves the kernel's tracing settings as it found them.
T=/sys/kernel/tracing
O=/out
state() { echo "tracer=$(cat $T/current_tracer) on=$(cat $T/tracing_on) buf=$(cat $T/buffer_size_kb) pid=$(cat $T/set_ftrace_pid | tr '\n' ' ') graph=$(cat $T/set_graph_function | tr '\n' ' ') depth=$(cat $T/max_graph_depth) switch=$(cat $T/events/sched/sched_switch/enable) opts=$(cat $T/trace_options | tr '\n' ' ')"; }

dmesg | grep -i ftrace > $O/dmesg-ftrace.txt
state > $O/state.before
{
	set -x
	ftscope-record -o $O/record-cmd.trace -- cat /proc/version;              echo "exit=$?"
	ftscope-record -r -a -o $O/record-cmd-ra.trace -- ls -l /bin;            echo "exit=$?"
	ftscope-record -g vfs_read -o $O/record-graph.trace -- cat /proc/version; echo "exit=$?"
	ftscope-record -d 1 -o $O/record-depth1.trace -- ls /;                   echo "exit=$?"
	sh /bin/multitask > /dev/null & ftscope-record -s 1 -b 4096 -o $O/record-system.trace; echo "exit=$?"; wait
	ftscope-record -o $O/record-fail.trace -- sh -c 'exit 7';                echo "exit=$? (expect 7)"
	ftscope-record -h;                                                       echo "exit=$?"
	set +x
} > $O/record-test.log 2>&1
state > $O/state.after
cmp -s $O/state.before $O/state.after && echo "STATE RESTORED" >> $O/record-test.log || echo "STATE CHANGED" >> $O/record-test.log
wc -l $O/*.trace >> $O/record-test.log
