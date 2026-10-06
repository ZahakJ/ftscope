# ftscope — design

This file is the contract. Code that disagrees with it is wrong, or this file
needs changing first.

## What it is

A page you drop an ftrace text file onto. It answers three questions, in this
order, without being asked:

1. **What is in this trace?** How long, which tasks and CPUs, how many calls,
   how trustworthy (lost events, cut-off calls, missing timestamps).
2. **Where did the time go?** By function and by call path.
3. **What was unusual, and why?** The calls that took far longer than other
   calls of the same function, each with the reason found for it.

Every claim it makes is one click from the raw lines that prove it.

Nothing leaves the machine: parsing and analysis run in the browser, there is
no server and no network request after the page loads.

## The three ideas

An ftrace is a wall of text because it is almost all repetition. A
function_graph trace of a thousand `read()` calls prints the same thirty lines
a thousand times, and the three calls that matter are in there somewhere. So:

**1. Fold repetition.** Consecutive calls to the same function collapse into
one row — `×1000 vfs_read  median 2.1 µs  max 194 µs` — which opens into the
*typical* call tree of the group plus its odd members, pinned by name.
Repeating sequences (`read, write, read, write`) fold the same way. This is
the **Story**: the trace in the order it happened, at the length a person
would tell it.

**2. Compare each call with its peers.** Every call of `vfs_read` is measured
against all the other calls of `vfs_read` in the trace. A call far above the
typical duration is an **outlier**, and it is *explained*: its call tree is
compared with the typical tree and the excess time is followed down to where
it concentrates — a path the other calls never take, a child called more
times, time switched out, an interrupt that landed inside it. The answer is a
sentence and a chain of functions, not a diff to read.

**3. Account for time honestly.** A function_graph duration is wall time: it
includes time the task was switched out and interrupts that fired inside the
call. ftscope splits each call's duration into *self*, *children*, *off-CPU*
and *interrupt* time, so "this read took 111 µs" becomes "this read took
8 µs; a timer interrupt took the other 103".

## Layout

One screen, four regions, all linked through one selection.

```
┌ top bar ── ftscope · file name · chips (duration, CPUs, tasks, calls, tracer) ── search ── Timeline | Story ── ? ┐
├ overview strip: the whole trace, one thin row per CPU; the visible window is a brush; outliers are pins ────────┤
├───────────────┬─────────────────────────────────────────────────────────────────┬───────────────────────────────┤
│ left  300px   │ main                                                            │ inspector  360px              │
│ Brief |       │   Timeline: one lane per task, calls nested downward, true time │   what is selected, where its │
│ Functions     │   Story:    folded call tree, true order                        │   time went, why it was slow, │
│               │                                                                 │   the raw lines               │
└───────────────┴─────────────────────────────────────────────────────────────────┴───────────────────────────────┘
```

- **Brief** (left, default): at most ~8 findings, most important first; each
  is a title, a number, one sentence, and clicking it goes there.
- **Functions** (left, other tab): every function with calls, self, total,
  typical, max and a small duration histogram; sortable; filtered by search.
- **Timeline**: lanes are tasks (threads). Calls are boxes nested downward by
  depth. Time is true (or reconstructed, and it says so). Events are small
  marks on the lane; lost-event gaps are hatched; off-CPU stretches inside a
  call are drawn hollow. Colour is by subsystem, or — the other mode — by
  *surprise*: everything grey except calls slow among their peers.
- **Story**: the folded tree described above, virtualised, keyboard-driven.
- **Inspector**: for a call — name, arguments and return value when printed,
  duration with the self/children/off-CPU/interrupt split, where it sits among
  its peers (a histogram with a mark), "why this one was slow", and the raw
  trace lines. For a function — its statistics, callers, callees, slowest calls.
- **Empty state**: a drop target, the sentence "nothing is uploaded", two demo
  traces, and the one command that records a good trace.

Keyboard: `/` search · `1` timeline · `2` story · `w` `s` zoom · `a` `d` pan ·
`f` fit selection · `0` fit all · `[` `]` previous/next call of the same
function · `o` next outlier · `c` colour mode · `Esc` clear · `?` help.

Not on the screen, on purpose: settings pages, per-view toolbars, a legend
that is always open, tabs inside tabs, modal dialogs other than help.

## Visual language

Tokens are in `src/ui/tokens.css`; use them, never literal colours.

- Neutral greys, one gold accent (`--accent`) for selection and the things you
  can act on. No purple or blue tint on surfaces, no yellow or sepia cast on
  backgrounds or text. Dark is the default; light follows the OS.
- Function names, numbers with units and raw trace text are monospace
  (`--font-mono`); everything else is the system UI font. No web fonts.
- Category colours (`--cat-*`) mean kernel subsystem and nothing else. Status
  colours (`--warn`, `--serious`, `--critical`) mean "the trace is unreliable
  here" or "this is an outlier", always with a glyph or a word, never alone.
- Text is never coloured with a category colour; a swatch beside it carries it.
- Durations are printed with three significant digits and a unit that fits:
  `812 ns`, `8.21 µs`, `194 µs`, `2.10 ms`, `1.25 s`. Counts get thin-space
  thousands separators. Use `src/ui/format.ts` (owned by the shell).
- Dense, quiet, precise: 13 px UI text, 12 px mono, hairline borders, no
  shadows except the help sheet, no gradients, no emoji. Motion only for
  zoom/pan (150 ms ease-out) and respected `prefers-reduced-motion`.

## Data flow

```
file (text or .gz) ──► worker: parse (src/core/parse) ──► Trace ──► analyze (src/core/analyze) ──► Analysis
                                                             └────────── posted to the page ──────────┘
page: signals in src/ui/state.ts ◄──► Brief, Functions, Timeline, Story, Inspector
      queries on demand: explain(), storyChildren(), profile(), funcDetail()
```

- `src/core/model.ts` — the Trace (plain data, typed arrays). **Contract.**
- `src/core/builder.ts` — `TraceBuilder`, the only code that assembles a Trace.
- `src/core/api.ts` — the Analysis and query result types. **Contract.**
- `src/ui/state.ts` — the shared signals and actions. **Contract.**
- The decompressed text is kept as a `Blob` (`file.value.text`) so any span's
  raw lines are `text.slice(byteStart, byteEnd)`.

Changing a contract file is allowed when it is wrong, but say so loudly in
your final report: other people are coding against it at the same time.

## Formats

Ground truth is `examples/traces/` — real output of Linux 7.1.8 captured by
`lab/` (see `examples/traces/README.md` for what produced each file, and the
`.cmds` file next to each trace). Every file there must parse with zero
unparsed lines. Supported in v1:

- `function_graph`, every column combination: bare; CPU; `funcgraph-proc`;
  `funcgraph-abstime`; duration with the overhead marks `+ ! # * @ $`;
  `latency-format` flags; `funcgraph-tail` (`} /* name */`);
  `funcgraph-retval` (`/* ret=0x0 */`, `} /* name ret=-8 */`);
  `funcgraph-args` (`name(a=1, b=0x2) {`); `funcgraph-retaddr`
  (`/* <-caller+0x24/0x120 */`, combined with ret as
  `/* <-caller+0x1/0x2 ret=0x0 */`); events as comments
  (`/* sched_switch: … */`); switch banners; `CPU:n [LOST m EVENTS]`;
  `tracing_thresh` output (closing lines only); `max_graph_depth` output;
  the older `/* = 0x0 */` retval style and the `==========>` / `<==========`
  interrupt markers from older kernels (documented, not in the examples).
- `function` tracer: default, `noirq-info`, `noprint-parent`,
  `latency-format`. No durations exist; calls become `NO_DUR` leaf spans with
  `caller` set.
- Plain trace events (`comm-pid [cpu] flags ts: name: fields`), alone or mixed.
- `trace-cmd report` text of the above (`comm-pid [cpu] ts: funcgraph_entry:
  … | func() {`), from documentation; no real sample in the examples yet.
- gzip: detected by magic bytes and inflated with `DecompressionStream`.

Things the examples teach (do not rediscover them):

- `funcgraph-abstime` prints **microseconds, truncated**, while durations have
  nanosecond digits. Many lines share a timestamp. Lay calls out with the
  durations *inside* the microsecond the timestamp names: a line stamped `T`
  happened in `[T, T+1 µs)`, after everything before it on that CPU.
- Without `funcgraph-abstime` there are no timestamps at all. Time is then
  laid out per CPU from the durations (`meta.clock = 'reconstructed'`), and the
  interface says so wherever it shows a time.
- Nesting belongs to the **task**, not the CPU. A task switched out inside
  `schedule()` resumes later, maybe on another CPU, and its closing braces
  continue there. Tasks come from the `funcgraph-proc` column or from the
  `prev => next` banners; before the first banner on a CPU the owner is
  unknown until the banner names `prev`.
- Indentation is two spaces per depth and is the truth about depth after lost
  events; use it to resynchronise a stack.
- Orphan closing lines print the function name even without `funcgraph-tail`.
- There are no interrupt markers on x86-64 (the `==========>` lines need a
  traced function inside the interrupt-entry text section, and there is none),
  and no enclosing interrupt function either: the entry stub is untraced. An
  interrupt shows up as a run of sibling calls, `irq_enter_rcu`,
  `__sysvec_apic_timer_interrupt`, `irq_exit_rcu`,
  `raw_irqentry_exit_cond_resched`, flagged `F.IRQ` with everything below them.
- Under full tracing most of the time is spent in the tracer's own hooks, so
  that is where interrupts usually land, and the text shows it three ways:
  1. the run is printed one level too deep, right **before** the line of the
     call that was being entered. If that call's printed duration can hold the
     run, the interrupt fired after its clock started: the run is its first
     children (a "leaf" line like `+ 59.521 us | __rcu_read_unlock();` can
     therefore have children). If it cannot, the interrupt fired before the
     clock started: the run belongs to the parent, just before the call.
  2. the run is printed as the **last** children of a call whose printed
     duration is too short to hold it: the interrupt fired in the exit hook
     after the clock stopped. The run belongs to the parent, just after the call.
  3. otherwise it is simply inside the call that was running.
  The printed duration is always the truth; the parser moves runs so that the
  tree agrees with it (`TraceBuilder.shed`, `adoptDeeperBefore`, `releaseRun`).
- A printed duration is exact; a position inside the parent is not. Children
  are slid to fit inside their parent's printed duration (`TraceBuilder.fit`),
  never the other way round.
- Span ids are **not** a topological order: an orphan, or a call that adopted an
  interrupt run, has a larger id than its children. Walk the tree
  (`firstChild` / `nextSibling`) when order matters.
- In pid-filtered traces the comm is the final one (`cat`), also for lines
  from before `exec`.
- Task comms contain spaces, dashes, colons and slashes (`kworker/0:1H-kblockd`);
  the pid is what follows the **last** dash. Comms are truncated in banners
  (`multita-464`) — identify tasks by pid.

## The mystery — the acceptance test

`examples/traces/07-mystery.trace`: 1000 × `read(/dev/vdb, 4096)`. Three reads
(iterations 137, 512, 846) miss the page cache and go to disk
(`filemap_add_folio` → `submit_bio` → `io_schedule`, switched out and back).
About nine others are slow only because a timer interrupt landed inside them.

Opened cold, with nothing clicked, the Brief must say that three reads were
slow because they went to disk and slept, name the function chain, and say
separately that some reads were inflated by interrupts. In the Story, the
thousand reads must be one row that opens to show a typical read plus the
slow ones, by name. If ftscope cannot do this, it does not do its job.

## Who owns what

| Area | Files | Tests |
| --- | --- | --- |
| parser | `src/core/parse/**`, `src/core/builder.ts` | `tests/parse/**` |
| analysis | `src/core/analyze/**`, `src/core/categories.ts` | `tests/analyze/**` |
| timeline | `src/ui/timeline/**` | `tests/timeline/**` |
| shell | `index.html`, `src/main.tsx`, `src/ui/app.tsx`, `src/ui/shell/**`, `src/ui/format.ts`, `src/ui/styles.css`, `src/core/worker.ts`, `public/**` | `tests/shell/**` |
| inspector + story | `src/ui/inspector/**`, `src/ui/story/**` | `tests/inspector/**`, `tests/story/**` |

Entry points the areas promise each other:

```ts
// src/core/parse/index.ts
export class TraceParser {
  /** Feed bytes of the text in order; chunks may end anywhere. */
  push(bytes: Uint8Array): void;
  /** Lines and bytes consumed so far, for a progress bar. */
  readonly progress: { lines: number; bytes: number };
  finish(): Trace;
}
export function parseText(text: string): Trace; // convenience for tests

// src/core/analyze/index.ts  — see AnalyzeModule in src/core/api.ts
export function analyze(trace: Trace): Analysis;
export function explain(trace: Trace, a: Analysis, span: number): Explanation;
export function storyChildren(trace: Trace, a: Analysis, parent: number, track?: number): StoryNode[];
export function profile(trace: Trace, a: Analysis, spans: Int32Array): ProfileNode;
export function funcDetail(trace: Trace, a: Analysis, func: number): FuncDetail;

// src/ui/timeline/index.ts  — framework-free; reads and writes src/ui/state.ts
export function mountTimeline(el: HTMLElement): () => void; // returns unmount
export function mountOverview(el: HTMLElement): () => void;

// src/ui/inspector/index.tsx, src/ui/story/index.tsx  — Preact components
export function Inspector(): JSX.Element;
export function Story(): JSX.Element;

// src/ui/format.ts
export function fmtDur(us: number): string;      // '8.21 µs'
export function fmtCount(n: number): string;     // '51 830'
export function fmtTime(us: number, span: number): string; // a point in time, precision fit to the visible span
export function fmtBytes(n: number): string;

// src/core/worker.ts — messages
// page → worker:  { type: 'load', name: string, blob: Blob }
// worker → page:  { type: 'progress', bytes: number, total: number, note: string }
//                 { type: 'done', trace: Trace, analysis: Analysis, text: Blob, name: string }
//                 { type: 'error', message: string }
```

## Rules for everyone building this

- TypeScript strict. No dependencies beyond `preact` and `@preact/signals`.
- Comments say why, not what; match the density of `src/core/builder.ts`.
- Performance is a feature: a 40 MB trace (about 500 000 calls) parses and
  analyses in a few seconds and pans at 60 fps. No per-span objects in hot
  paths; typed arrays and indices.
- Never crash on input. A line that is not understood is counted and sampled
  in `meta`, and the rest of the file still loads.
- This machine is shared and has been OOM-killed by parallel browser captures.
  **Do not launch a browser, Playwright, a dev server or a preview server**
  unless your brief says you may. `npm test` scoped to your own directory,
  and `npx tsc --noEmit` are what you run. Never use `pkill -f`.
- Do not `git init`, commit, or touch anything outside this repository.
