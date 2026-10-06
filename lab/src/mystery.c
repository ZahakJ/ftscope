/* mystery: read() a block device in 4 KiB chunks; a few chunks are secretly cold.
 *   mystery prep DEV N  -- warm the page cache with N chunks, then evict a few
 *   mystery run  DEV N  -- read N chunks sequentially, print per-call latency
 * Run with /sys/block/<dev>/queue/read_ahead_kb = 0 so a miss is exactly one 4 KiB I/O. */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const long cold[] = {137, 512, 846}; /* the ground truth */
static long ns(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000000000L + t.tv_nsec; }

int main(int argc, char **argv) {
	if (argc != 4) return fprintf(stderr, "usage: mystery prep|run DEV N\n"), 2;
	long n = atol(argv[3]); static char buf[4096];
	int fd = open(argv[2], O_RDONLY);
	if (fd < 0) return perror("open"), 1;
	if (!strcmp(argv[1], "prep")) {
		posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
		for (long i = 0; i < n; i++) if (read(fd, buf, sizeof buf) != sizeof buf) return 1;
		for (unsigned i = 0; i < sizeof cold / sizeof *cold; i++)
			posix_fadvise(fd, cold[i] * 4096, 4096, POSIX_FADV_DONTNEED);
		return 0;
	}
	long *lat = calloc(n, sizeof *lat);
	for (long i = 0; i < n; i++) {
		long t = ns();
		if (read(fd, buf, sizeof buf) != sizeof buf) return 1;
		lat[i] = ns() - t;
	}
	for (long i = 0; i < n; i++) printf("%ld,%ld\n", i, lat[i]);
	return 0;
}
