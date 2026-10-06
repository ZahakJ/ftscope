/* bench: ns/call for a cheap syscall loop. Usage: bench [getppid_iters] [read_iters] [cpu] */
#define _GNU_SOURCE
#include <sched.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }

int main(int argc, char **argv) {
	long n1 = argc > 1 ? atol(argv[1]) : 2000000, n2 = argc > 2 ? atol(argv[2]) : 200000;
	if (argc > 3) { cpu_set_t s; CPU_ZERO(&s); CPU_SET(atoi(argv[3]), &s); sched_setaffinity(0, sizeof s, &s); }
	char c; int fd = open("/dev/zero", O_RDONLY);
	double t0 = now();
	for (long i = 0; i < n1; i++) syscall(SYS_getppid); /* bypass any libc caching */
	double t1 = now();
	for (long i = 0; i < n2; i++) if (read(fd, &c, 1) != 1) return 1;
	double t2 = now();
	printf("%.1f,%.1f\n", (t1 - t0) / n1, (t2 - t1) / n2);
	return 0;
}
