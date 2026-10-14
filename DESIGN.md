# ftscope internals

## Data flow

```
file (text or .gz) ──► worker: parse (src/core/parse) ──► Trace ──► analyze (src/core/analyze) ──► Analysis
                                                             └────────── posted to the page ──────────┘
page: signals in src/ui/state.ts ◄──► Brief, Functions, Timeline, Story, Inspector
      queries on demand: explain(), storyChildren(), profile(), funcDetail()
```

- `src/core/model.ts`: the Trace (plain data, typed arrays).
- `src/core/builder.ts`: `TraceBuilder`, the only code that assembles a Trace.
- `src/core/api.ts`: Analysis and query result types.
- `src/ui/state.ts`: shared signals and actions.
- `src/ui/tokens.css`: colours and sizes. `src/ui/format.ts`: number formatting.
- The decompressed text is kept as a `Blob`; a span's raw lines are
  `text.slice(byteStart, byteEnd)`.

Worker messages:

```
page → worker:  { type: 'load', name, blob }
worker → page:  { type: 'progress', bytes, total, note }
                { type: 'done', trace, analysis, text, name }
                { type: 'error', message }
```

## Formats

`examples/traces/` is the reference: every file there parses with zero
unparsed lines. Read:

- `function_graph`, every column combination: bare; CPU; `funcgraph-proc`;
  `funcgraph-abstime`; duration with overhead marks `+ ! # * @ $`;
  `latency-format`; `funcgraph-tail`; `funcgraph-retval` (`/* ret=0x0 */`,
  `} /* name ret=-8 */`); `funcgraph-args`; `funcgraph-retaddr`; events as
  comments; switch banners; `CPU:n [LOST m EVENTS]`; `tracing_thresh`;
  `max_graph_depth`; the older `/* = 0x0 */` retval and `==========>`
  interrupt markers.
- `function` tracer: default, `noirq-info`, `noprint-parent`,
  `latency-format`. No durations; calls become `NO_DUR` leaf spans with
  `caller` set.
- Plain trace events (`comm-pid [cpu] flags ts: name: fields`).
- `trace-cmd report` text (from documentation; no real sample yet).
- gzip, by magic bytes, through `DecompressionStream`.

Unparsed lines are counted and sampled in `meta`; the rest still loads.

## Facts about the text

- `funcgraph-abstime` prints microseconds, truncated; durations have
  nanosecond digits. A line stamped `T` happened in `[T, T+1 µs)`, after
  everything before it on that CPU.
- Without `funcgraph-abstime` there are no timestamps. Time is laid out per
  CPU from the durations (`meta.clock = 'reconstructed'`), and the UI says so.
- Nesting belongs to the task, not the CPU. A task switched out inside
  `schedule()` may resume on another CPU and close its braces there. Tasks
  come from the `funcgraph-proc` column or from `prev => next` banners.
- Indentation is two spaces per depth; after lost events it resynchronises
  the stack.
- Orphan closing lines print the function name even without `funcgraph-tail`.
- x86-64 has no interrupt markers and no enclosing interrupt function. An
  interrupt is a run of siblings (`irq_enter_rcu`,
  `__sysvec_apic_timer_interrupt`, `irq_exit_rcu`,
  `raw_irqentry_exit_cond_resched`) flagged `F.IRQ`.
- Under full tracing interrupts mostly land in the tracer's hooks and print
  in one of three places:
  1. one level too deep, before the line of the call being entered. If that
     call's duration can hold the run, the run is its first children;
     otherwise it belongs to the parent, before the call.
  2. as the last children of a call whose duration is too short to hold it.
     It belongs to the parent, after the call.
  3. inside the call that was running.
  The printed duration wins; the parser moves runs to agree with it
  (`TraceBuilder.shed`, `adoptDeeperBefore`, `releaseRun`).
- Children are slid to fit their parent's printed duration
  (`TraceBuilder.fit`), never the reverse.
- Span ids are not a topological order: an orphan, or a call that adopted an
  interrupt run, has a larger id than its children. Walk
  `firstChild` / `nextSibling` when order matters.
- In pid-filtered traces the comm is the final one, also before `exec`.
- Comms contain spaces, dashes, colons and slashes; the pid follows the last
  dash. Banners truncate comms; identify tasks by pid.

## The mystery trace

`examples/traces/07-mystery.trace`: 1000 × `read(/dev/vdb, 4096)`. Reads 137,
512 and 846 miss the page cache (`filemap_add_folio` → `submit_bio` →
`io_schedule`). About nine others are slow only because a timer interrupt
landed in them. Opened with nothing clicked, the Brief names the three disk
reads and their chain and lists the interrupt-inflated reads separately; the
Story shows the thousand reads as one row. `tests/analyze/mystery.test.ts`
checks this.
