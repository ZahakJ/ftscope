#!/bin/sh
# Runs inside the ftscope-lab container: build initramfs, boot the VM, unpack results.
set -eu
B=/lab/build; R=$B/root
rm -rf $R && mkdir -p $R/bin $R/proc $R/sys $R/dev $R/out
cp /bin/busybox.static $R/bin/busybox
for f in /lab/src/*.c; do gcc -static -O2 -Wall -o $R/bin/$(basename $f .c) $f; done
cp /lab/guest/init $R/init; cp /lab/${SCRIPT:-guest/experiments.sh} $R/experiments.sh; cp /lab/guest/multitask $R/bin/multitask
cp $B/ftscope-record $R/bin/ftscope-record
chmod +x $R/init $R/bin/*
(cd $R && find . | cpio -o -H newc --quiet | gzip -1) > $B/initramfs.gz

rm -f $B/scratch.img; truncate -s 1G $B/scratch.img          # results come back as a tar on vda
head -c 8388608 /dev/urandom > $B/data.img                         # vdb: the mystery's raw disk

timeout -s KILL "${VM_TIMEOUT:-1500}" qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m 1G \
	-kernel $B/vmlinuz -initrd $B/initramfs.gz \
	-append "console=ttyS0 panic=-1 loglevel=4" \
	-drive file=$B/scratch.img,format=raw,if=virtio \
	-drive file=$B/data.img,format=raw,if=virtio \
	-nographic -no-reboot -nic none | tee $B/console.log

mkdir -p /lab/${OUT:-out} && cd /lab/${OUT:-out} && tar xf $B/scratch.img
rm -f $B/scratch.img
