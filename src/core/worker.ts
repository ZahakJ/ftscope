// Parses and analyses a trace off the main thread.
//
// page → worker:  { type: 'load', name, blob }
// worker → page:  { type: 'progress', bytes, total, note } (throttled)
//                 { type: 'done', trace, analysis, text, name }
//                 { type: 'error', message }

import { analyze } from './analyze';
import type { Analysis } from './api';
import type { Trace } from './model';
import { TraceParser } from './parse';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<{ type: 'load'; name: string; blob: Blob }>) => {
  if (e.data?.type !== 'load') return;
  run(e.data.name, e.data.blob).catch((err: unknown) => {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};

async function run(name: string, blob: Blob): Promise<void> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gz = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
  // Count input bytes before inflation so progress is against the known file size.
  let consumed = 0;
  let stream: ReadableStream<Uint8Array> = blob.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        consumed += chunk.length;
        c.enqueue(chunk);
      },
    }),
  );
  if (gz) stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);

  const parser = new TraceParser();
  // Kept so raw lines can be shown later without a second decompression.
  const chunks: Uint8Array[] = [];
  let decoded = 0;
  const total = blob.size;
  let lastPost = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    decoded += value.length;
    parser.push(value);
    const now = performance.now();
    if (now - lastPost > 80) {
      lastPost = now;
      ctx.postMessage({
        type: 'progress',
        bytes: consumed,
        total,
        note: `Reading lines… ${parser.progress.lines.toLocaleString('en')} so far${gz ? ' (decompressed ' + mb(decoded) + ')' : ''}`,
      });
    }
  }
  ctx.postMessage({ type: 'progress', bytes: total, total, note: 'Assembling calls…' });
  await tick();
  const trace: Trace = parser.finish();
  ctx.postMessage({ type: 'progress', bytes: total, total, note: `Comparing ${trace.spans.n.toLocaleString('en')} calls with their peers…` });
  await tick();
  const analysis: Analysis = analyze(trace);
  const text = new Blob(chunks as BlobPart[], { type: 'text/plain' });
  ctx.postMessage({ type: 'done', trace, analysis, text, name }, transferables(trace, analysis));
}

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MiB`;
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Every typed-array buffer reachable one or two levels down, deduplicated; the worker never touches them again. */
function transferables(...roots: object[]): Transferable[] {
  const out = new Set<ArrayBuffer>();
  const visit = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (ArrayBuffer.isView(o)) {
      if (o.buffer instanceof ArrayBuffer && o.byteOffset === 0 && o.byteLength === o.buffer.byteLength) out.add(o.buffer);
      return;
    }
    if (Array.isArray(o)) {
      // funcStats: an array of objects each holding a small histogram.
      if (o.length && typeof o[0] === 'object') for (const x of o) visit(x, depth + 1);
      return;
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return [...out];
}
