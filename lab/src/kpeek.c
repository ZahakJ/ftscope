/* kpeek: print the first 16 bytes of kernel functions, read from /proc/kcore.
 * Addresses come from /proc/kallsyms; kcore's ELF64 PT_LOAD headers map vaddr -> file offset.
 * Also decodes the ftrace site (endbr64 + nop5 / call rel32) and names the call target. */
#include <elf.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct sym { unsigned long a; char n[128]; };
static struct sym *syms; static long nsyms;

static int cmp(const void *x, const void *y) {
	unsigned long a = ((struct sym *)x)->a, b = ((struct sym *)y)->a; return a < b ? -1 : a > b;
}
static void load(void) {
	FILE *f = fopen("/proc/kallsyms", "r"); char line[512]; long cap = 0;
	while (fgets(line, sizeof line, f)) {
		if (nsyms == cap) syms = realloc(syms, (cap = cap ? cap * 2 : 65536) * sizeof *syms);
		char t, name[256] = "", mod[256] = "";
		if (sscanf(line, "%lx %c %255s %255s", &syms[nsyms].a, &t, name, mod) < 3) continue;
		snprintf(syms[nsyms].n, sizeof syms[nsyms].n, mod[0] ? "%s %s" : "%s", name, mod);
		nsyms++;
	}
	qsort(syms, nsyms, sizeof *syms, cmp);
}
static unsigned long lookup(const char *n) {
	for (long i = 0; i < nsyms; i++) if (!strcmp(syms[i].n, n)) return syms[i].a;
	return 0;
}
static void resolve(unsigned long a, char *out, size_t sz) {
	long lo = 0, hi = nsyms - 1, best = -1;
	while (lo <= hi) { long m = (lo + hi) / 2; if (syms[m].a <= a) best = m, lo = m + 1; else hi = m - 1; }
	if (best < 0) snprintf(out, sz, "?");
	else snprintf(out, sz, "%s+0x%lx", syms[best].n, a - syms[best].a);
}

int main(int argc, char **argv) {
	load();
	if (nsyms == 0 || syms[nsyms - 1].a == 0) return fprintf(stderr, "kallsyms addresses hidden\n"), 1;
	int fd = open("/proc/kcore", O_RDONLY);
	if (fd < 0) return perror("/proc/kcore"), 1;
	Elf64_Ehdr eh; pread(fd, &eh, sizeof eh, 0);
	Elf64_Phdr *ph = malloc(eh.e_phnum * sizeof *ph);
	pread(fd, ph, eh.e_phnum * sizeof *ph, eh.e_phoff);
	for (int i = 1; i < argc; i++) {
		unsigned long a = lookup(argv[i]); unsigned char b[16]; off_t off = -1;
		if (!a) { printf("%s: not in kallsyms\n", argv[i]); continue; }
		for (int j = 0; j < eh.e_phnum; j++)
			if (ph[j].p_type == PT_LOAD && a >= ph[j].p_vaddr && a + 16 <= ph[j].p_vaddr + ph[j].p_filesz)
				off = ph[j].p_offset + (a - ph[j].p_vaddr);
		if (off < 0 || pread(fd, b, 16, off) != 16) { printf("%s: unreadable in kcore\n", argv[i]); continue; }
		printf("%-16s %016lx:", argv[i], a);
		for (int k = 0; k < 16; k++) printf(" %02x", b[k]);
		/* entry may start with endbr64, or with its sealed form (objtool/IBT: "nopl -0x2a(%rax)") */
		int endbr = !memcmp(b, "\xf3\x0f\x1e\xfa", 4), sealed = !memcmp(b, "\x0f\x1f\x40\xd6", 4), p = endbr || sealed ? 4 : 0;
		printf("\n    %s", endbr ? "endbr64 ; " : sealed ? "nopl -0x2a(%rax) [sealed endbr] ; " : "");
		if (!memcmp(b + p, "\x0f\x1f\x44\x00\x00", 5)) printf("nopl 0x0(%%rax,%%rax,1)   <- ftrace site disabled\n");
		else if (b[p] == 0xe8) {
			int rel; memcpy(&rel, b + p + 1, 4); unsigned long t = a + p + 5 + (long)rel; char nm[200];
			resolve(t, nm, sizeof nm);
			printf("call 0x%lx <%s>   <- ftrace site enabled\n", t, nm);
		} else printf("(not an ftrace nop/call at +%d)\n", p);
	}
	return 0;
}
