# Example traces

These are real ftrace captures from Linux **7.1.8-arch1-3** (Arch's stock kernel) running
in a 4-vCPU, 1 GiB KVM guest. Everything here was produced by `./lab/run.sh`, which
regenerates the whole directory. Each `NN-name.trace` comes with an `NN-name.cmds` file
listing the exact tracefs writes that made it, in order and relative to
`/sys/kernel/tracing`.

Unless a `.cmds` file says otherwise, every capture starts from these defaults: all
options at their boot values (`00-env/options.default`), `buffer_size_kb=1408`,
`trace_clock=local`, no filters, and no events.

"pid-filtered" means the workload was started as
`sh -c 'echo $$ > set_ftrace_pid; echo $$ > set_event_pid; echo 1 > tracing_on; exec WORKLOAD'`.
As a result, these traces begin in the middle of the shell's `write()` to `tracing_on`.
The task name shown is the *final* comm (`cat`), even for events that happened before the
`exec`, because ftrace resolves comms from its saved-cmdlines table when the trace is read.

| file | tracer | options / setup | workload |
|---|---|---|---|
| 00-env/ | | `uname`, `available_tracers`, `trace_options`, `options/` listing, `README`, `dyn_ftrace_total_info`, filter-function count + first 40, `set_ftrace_notrace`, `trace_clock`, buffer sizes, kernel config excerpt | |
| 01-nop-patching.txt | function, function_graph | the first 16 bytes of `vfs_read`, `ksys_write` and `do_sys_openat2` read from `/proc/kcore` (by `src/kpeek.c`) in 5 states; `.enabled_functions.b` is `enabled_functions` in state (b) | |
| 02-function-default | function | defaults | pid-filtered `cat /proc/version` |
| 02-function-noirqinfo | function | `noirq-info` (no flags column) | same |
| 02-function-latency | function | `latency-format` | same |
| 02-function-noparent | function | `noprint-parent` (no `<-caller`) | same |
| 03-graph-default | function_graph | defaults | same |
| 03-graph-system | function_graph | unfiltered, `buffer_size_kb=4096`, 80 ms | `multitask` running in the background |
| 04-graph-rich | function_graph | abstime, proc, cpu, duration, irqs, tail | pid-filtered `cat /proc/version` |
| 04-graph-retval / -retval-hex | function_graph | `funcgraph-retval` (+ `funcgraph-retval-hex`) | same |
| 04-graph-args | function_graph | `funcgraph-args` | same |
| 04-graph-retaddr | function_graph | `funcgraph-retaddr` | same |
| 04-graph-latency | function_graph | `latency-format` | same |
| 04-graph-noirqinfo | function_graph | `noirq-info` (makes no difference to the output) | same |
| 04-graph-bare | function_graph | `nofuncgraph-cpu nofuncgraph-overhead nofuncgraph-duration` | same |
| 04-graph-everything | function_graph | rich + retval + args + retaddr | same |
| 04-graph-events | function_graph | rich, function-fork, event-fork, plus events sched_switch, sched_wakeup, irq_handler_entry/exit, softirq_entry/exit, raw_syscalls sys_enter/exit | pid-filtered `multitask` |
| 05-multitask-proc / -noproc | function_graph | function-fork, `buffer_size_kb=4096`, with and without `funcgraph-proc` (shows the `=>` context-switch banners) | pid-filtered `multitask` |
| 06-lost-events | function | `buffer_size_kb=8`, read concurrently from `trace_pipe` (contains `CPU:n [LOST m EVENTS]`) | unfiltered `multitask` |
| 06-orphans | function_graph | unfiltered, `buffer_size_kb=64`; the buffer wrapped, so the trace opens with orphan `}` lines and ends with unclosed `{` | unfiltered `multitask` |
| 07-mystery | function_graph | abstime, proc, retval, function-fork, event-fork, the same events as 04-graph-events, `buffer_size_kb=16384` | `mystery run /dev/vdb 1000` (see below) |
| 09-graph-thresh | function_graph | `tracing_thresh=20` (µs): only calls that took longer than 20 µs, printed as close lines | unfiltered `multitask` |
| 09-graph-depth1 | function_graph | `max_graph_depth=1` (top-level kernel entries only) | pid-filtered `ls -l /bin` |
| 09-events-only | nop | events sched_switch + sched_wakeup | unfiltered `multitask` |
| 09-per_cpu-cpu0-stats.txt | function | `per_cpu/cpu0/stats` after a short run | |
| overhead.csv / overhead.json | | see "Overhead" below | |

`multitask` (`lab/guest/multitask`) starts 6 subshells at once. Each runs
`head -c 32768 /dev/urandom | md5sum`, a short `usleep`, `echo | cat | wc -c` and `ls /bin`.

The ~40 MB performance trace (`04-big.trace`: rich options + retval + all the events
above, unfiltered, `buffer_size_kb=6144`, workload `multitask; ls -lR /; multitask`) is
only in `lab/out/`. Run `./lab/run.sh` to regenerate it.

## The mystery: ground truth

`mystery` reads `/dev/vdb` (a raw 8 MiB virtio disk) sequentially with 1000 × `read(fd, buf, 4096)`.
Beforehand, and untraced, `mystery prep` loads the whole range into the page cache and then
evicts exactly three 4 KiB pages with `posix_fadvise(DONTNEED)`. Readahead is off
(`read_ahead_kb=0`), so each eviction costs exactly one synchronous 4 KiB disk read. The
shell keeps `/dev/vdb` open the whole time, because the last close of a block device
drops its page cache.

**The slow iterations are 137, 512 and 846 (0-based read index).** The cause is a
page-cache miss. Their `__x64_sys_read` subtree contains
`filemap_add_folio` → `submit_bio` (a block I/O to virtio) → `io_schedule`, with a
`sched_switch` away and back while the disk answers. A normal read is 33 graph lines;
the cold ones are about 280–490 lines. (In one earlier run, read 512's completion arrived
before it slept, so it showed `irq_handler_entry` instead of `io_schedule`. Expect either
form.)

Numbers from the committed run:

- Untraced (`07-mystery.untraced-latency.csv`): median 0.68 µs; #137 = 44 µs, #846 = 34 µs,
  #512 = 31 µs (45–65×). One untraced decoy (#641, 27 µs) was most likely an interrupt.
- In the trace (`__x64_sys_read` duration): median about 8 µs; #137 = 194 µs, #512 = 88 µs,
  #846 = 88 µs.
- **Decoys, which appear only under tracing:** 9 reads (#3, 96, 160, 251, 532, 634, 732, 828
  and 921) take 48–111 µs because a local-APIC timer interrupt
  (`__sysvec_apic_timer_interrupt`, with its softirq/RCU work) landed inside them. #732 is
  slower than two of the real misses. None of them contain block I/O. A good viewer must
  rank by *why* a call was slow, not only by how long it took.
- `07-mystery.latency.csv` is the program's own per-call clock under tracing. It includes
  time outside the syscall, so it has a few extra outliers (for example #348) that do not
  show up as long `__x64_sys_read` blocks.

Read indices are counted as the order of top-level `__x64_sys_read() {` blocks for the
`mystery` pid in the trace. Exact numbers vary from run to run, but the three cold indices
are fixed in `src/mystery.c`.

## Overhead

`bench 2000000 200000 2` (pinned to vCPU 2) times `syscall(SYS_getppid)` and a 1-byte
`read()` of `/dev/zero`. It runs 5 times per configuration, with `tracing_on=1`.
`overhead.json` has the median, min, max and every run. A KVM guest with the default
mitigations makes syscalls themselves expensive, so the absolute numbers are higher than
on bare metal. The ratios are what matter.
