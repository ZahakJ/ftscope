# ftscope lab

A throwaway virtual machine that boots a real Linux kernel, turns ftrace on in many
different ways, and hands back the raw output. These files are the test fixtures and demo
traces for ftscope, and the evidence for the "how ftrace works" write-up.

Nothing touches your machine's own tracing: everything runs as root *inside* a KVM guest,
which runs inside a Docker container (no `--privileged`, only `--device /dev/kvm`).

## Run it

You need Docker and a readable/writable `/dev/kvm`.

```sh
./lab/run.sh
```

It takes about 2 minutes. To trace a different kernel, pass its bzImage:
`KERNEL=/path/to/bzImage ./lab/run.sh`. The kernel needs ftrace, function_graph,
virtio-blk, the 8250 serial console, devtmpfs and initramfs support built in (not as modules).

## What comes out

- `lab/out/`: everything, raw (git-ignored). This includes `04-big.trace` (about 40 MB,
  for performance testing), which is not copied to `examples/`.
- `examples/traces/`: the curated copy, documented in `examples/traces/README.md`.
- `lab/build/console.log`: the VM's serial console, which is where to look if something fails.

Every `NN-name.trace` has a matching `NN-name.cmds` listing the exact tracefs writes that
produced it.

## How it works

- `run.sh` (host) builds the image, copies the kernel, runs `inside.sh` in a container,
  then runs `curate.sh`.
- `inside.sh` (container) compiles `src/*.c` statically, packs busybox + those binaries +
  `guest/` into an initramfs, and boots QEMU (4 vCPUs, 1 GiB, hard 25-minute kill). The
  guest writes its results as a tar straight onto a raw virtio disk (`/dev/vda`), which
  the container then unpacks into `lab/out/`. A second disk (`/dev/vdb`, 8 MiB of random
  data) is the mystery workload's disk.
- `guest/experiments.sh` is the actual experiment list.
- `src/kpeek.c` reads kernel code bytes from `/proc/kcore`, `src/mystery.c` is the demo
  workload, and `src/bench.c` is the overhead benchmark.
