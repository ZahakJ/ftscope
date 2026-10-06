// Getting a trace into the page: files, URLs, drops and pastes all end in loadFile().

import { batch, signal } from '@preact/signals';
import type { Analysis } from '../../core/api';
import type { Trace } from '../../core/model';
import { analysis, file, load, selection, trace, zoomAll } from '../state';
// `?worker&inline` embeds the worker as a blob URL, so the single-file build
// works from file:// where a separate worker script could not be fetched.
import TraceWorker from '../../core/worker?worker&inline';

type FromWorker =
  | { type: 'progress'; bytes: number; total: number; note: string }
  | { type: 'done'; trace: Trace; analysis: Analysis; text: Blob; name: string }
  | { type: 'error'; message: string };

export const EMPTY_TITLE = 'ftscope — see what an ftrace says';

/** When the last load failed because nothing in the file was ftrace: the first lines, to show what it was. */
export const notTrace = signal<{ line: number; text: string }[] | null>(null);

let current: Worker | null = null;
const readyHooks: (() => void)[] = [];

/** Run once after the next trace has loaded (used to restore the URL hash). */
export function onNextReady(fn: () => void): void {
  readyHooks.push(fn);
}

export function markReady(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => ((window as unknown as { __ready: boolean }).__ready = true)));
}

export function loadFile(blob: Blob, name: string): void {
  current?.terminate();
  (window as unknown as { __ready: boolean }).__ready = false;
  const w = new TraceWorker();
  current = w;
  load.value = { phase: 'loading', name, bytes: 0, total: blob.size, note: 'Starting…' };
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    if (current !== w) return;
    const m = e.data;
    if (m.type === 'progress') {
      load.value = { phase: 'loading', name, bytes: m.bytes, total: m.total, note: m.note };
    } else if (m.type === 'error') {
      fail(name, m.message);
    } else {
      w.terminate();
      current = null;
      const c = m.trace.meta.counts;
      if (c.spans === 0 && c.events === 0) {
        fail(name, 'This does not look like an ftrace: no line was understood.', m.trace.meta.unparsedSamples.slice(0, 6));
        return;
      }
      batch(() => {
        notTrace.value = null;
        trace.value = m.trace;
        analysis.value = m.analysis;
        file.value = { name, size: m.text.size, text: m.text };
        selection.value = null;
        zoomAll();
        load.value = { phase: 'ready' };
      });
      document.title = `${name} — ftscope`;
      for (const fn of readyHooks.splice(0)) fn();
      markReady();
    }
  };
  w.onerror = (e) => {
    if (current === w) fail(name, e.message || 'The worker failed while reading this file.');
  };
  w.postMessage({ type: 'load', name, blob });
}

function fail(name: string, message: string, samples: { line: number; text: string }[] | null = null): void {
  current?.terminate();
  current = null;
  batch(() => {
    notTrace.value = samples;
    load.value = { phase: 'error', name, message };
  });
  document.title = EMPTY_TITLE;
  markReady();
}

export async function loadUrl(url: string): Promise<void> {
  const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url);
  load.value = { phase: 'loading', name, bytes: 0, total: 0, note: 'Fetching…' };
  try {
    const res = await fetch(new URL(url, location.href));
    if (!res.ok) throw new Error(`Could not fetch ${url}: ${res.status} ${res.statusText}`);
    loadFile(await res.blob(), name);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

export function pickFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.trace,.txt,.gz,.dat,text/plain,application/gzip';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) loadFile(f, f.name);
  };
  input.click();
}

/** Window-wide drop and paste. Returns a cleanup. `setDragging` drives the drop highlight. */
export function installInputs(setDragging: (on: boolean) => void): () => void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++depth === 1) setDragging(true);
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      setDragging(false);
    }
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setDragging(false);
    const f = e.dataTransfer!.files[0];
    if (f) loadFile(f, f.name);
  };
  const paste = (e: ClipboardEvent) => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return;
    const f = e.clipboardData?.files[0];
    if (f) {
      e.preventDefault();
      loadFile(f, f.name);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.includes('\n')) {
      e.preventDefault();
      loadFile(new Blob([text], { type: 'text/plain' }), 'pasted.trace');
    }
  };
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragover', over);
  window.addEventListener('dragleave', leave);
  window.addEventListener('drop', drop);
  window.addEventListener('paste', paste);
  return () => {
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragover', over);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('drop', drop);
    window.removeEventListener('paste', paste);
  };
}
