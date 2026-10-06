// The overview strip: the whole trace, one thin row per CPU shaded by traced
// time, lost-event gaps, outlier pins, and the current view as a brush.

import { effect } from '@preact/signals';
import type { Trace } from '../../core/model';
import { analysis, selectSpan, spanEnd, trace, view, zoomAll, zoomTo } from '../state';
import { fmtDur } from '../format';
import { mix, onSchemeChange, readPalette } from './colors';
import { coverage, pinAt, pinGroups, type PinGroup } from './layout';
import { setViewNow, shownView } from './shown';

const PIN = 9; // px reserved at the top for outlier pins
const BINS = 4096;

export function mountOverview(el: HTMLElement): () => void {
  // Our own positioned box: the host element's layout belongs to the shell.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden';
  el.append(wrap);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none';
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:fixed;pointer-events:none;display:none;z-index:50;max-width:380px;padding:5px 8px;border:1px solid var(--line-strong);' +
    'border-radius:var(--radius);background:var(--surface-2);color:var(--text);font:var(--fs-small)/1.4 var(--font-ui);white-space:normal';
  // The strip is short and clips: the tip lives on the body, positioned in viewport space.
  wrap.append(canvas);
  document.body.append(tip);
  let pins: PinGroup[] = [];
  const ctx = canvas.getContext('2d')!;
  let pal = readPalette();
  let cov: ReturnType<typeof coverage> | null = null;
  let covFor: Trace | null = null;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let raf = 0;

  const invalidate = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const toX = (t: number) => (cov ? ((t - cov.t0) / (cov.t1 - cov.t0)) * W : 0);
  const toT = (x: number) => (cov ? cov.t0 + (x / W) * (cov.t1 - cov.t0) : 0);

  function draw() {
    raf = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.surface1;
    ctx.fillRect(0, 0, W, H);
    const t = trace.value;
    if (!t) return;
    if (covFor !== t) {
      cov = coverage(t, BINS);
      covFor = t;
    }
    const c = cov!;
    const n = c.cpus.length;
    const rowH = (H - PIN - 2) / n;
    const labels = rowH >= 7;
    const lx = labels ? 34 : 0;
    // Density ramp from surface toward text-3, so a busy CPU reads darker in light, lighter in dark.
    const ramp = Array.from({ length: 9 }, (_, i) => mix(pal.text2, pal.surface1, 0.12 + (i / 8) * 0.78));
    for (let r = 0; r < n; r++) {
      const y = Math.round(PIN + r * rowH);
      const h = Math.max(1, Math.round(PIN + (r + 1) * rowH) - y - 1);
      ctx.fillStyle = pal.surface2;
      ctx.fillRect(lx, y, W - lx, h);
      const cells = c.cells[r];
      const per = BINS / (W - lx);
      for (let x = 0; x < W - lx; x++) {
        const a = Math.floor(x * per);
        const b = Math.max(a + 1, Math.floor((x + 1) * per));
        let s = 0;
        for (let i = a; i < b && i < BINS; i++) s += cells[i];
        const v = s / (b - a);
        if (v <= 0.002) continue;
        ctx.fillStyle = ramp[Math.min(8, Math.round(v * 8))];
        ctx.fillRect(lx + x, y, 1, h);
      }
      if (labels) {
        ctx.fillStyle = pal.text3;
        ctx.font = `${Math.min(10, Math.floor(rowH) + 1)}px ${pal.fontMono}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(`cpu${c.cpus[r]}`, 3, y + h / 2);
      }
    }
    const X = (tt: number) => lx + ((tt - c.t0) / (c.t1 - c.t0)) * (W - lx);
    ctx.fillStyle = pal.warn;
    for (const g of t.gaps) ctx.fillRect(Math.round(X(g.ts)), PIN, 1, H - PIN);
    const a = analysis.value;
    pins = [];
    if (a) {
      // Pins within a few px merge into one mark carrying a count.
      const os = a.outliers;
      // Merged when their marks would overlap (8 px wide), so each mark is one hover target.
      pins = pinGroups(os.map((o) => X(t.spans.start[o.span])), os.map((o) => t.spans.dur[o.span] || 0), 7);
      ctx.font = `9px ${pal.fontMono}`;
      ctx.textBaseline = 'top';
      pins.forEach((g, gi) => {
        const x = g.x + 0.5;
        ctx.fillStyle = pal.critical;
        ctx.beginPath();
        ctx.moveTo(x - 4, 0);
        ctx.lineTo(x + 4, 0);
        ctx.lineTo(x, PIN - 1);
        ctx.fill();
        if (g.members.length > 1) {
          const label = String(g.members.length);
          const lw = ctx.measureText(label).width;
          const next = pins[gi + 1]?.x ?? Infinity;
          const prev = pins[gi - 1]?.x ?? -Infinity;
          // The count sits beside the mark where there is room for it, else it is left to the tooltip.
          if (x + 5 + lw + 4 < Math.min(next - 4, W)) ctx.fillText(label, Math.round(x + 5), 0);
          else if (x - 5 - lw - 4 > prev + 4) ctx.fillText(label, Math.round(x - 5 - lw), 0);
        }
      });
    }
    // Brush: veil outside, accent edges.
    const v = shownView.value ?? view.value;
    const xa = Math.max(lx, Math.round(X(v.t0)));
    const xb = Math.max(xa + 2, Math.min(W, Math.round(X(v.t1))));
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = pal.surface1;
    ctx.fillRect(lx, PIN, xa - lx, H - PIN);
    ctx.fillRect(xb, PIN, W - xb, H - PIN);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(xa + 0.5, PIN + 0.5, xb - xa - 1, H - PIN - 1);
    ctx.fillStyle = pal.accent;
    ctx.fillRect(xa, PIN, 2, H - PIN);
    ctx.fillRect(xb - 2, PIN, 2, H - PIN);
    labelX = lx;
  }
  let labelX = 0;

  function resize() {
    const r = wrap.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, Math.floor(r.width));
    H = Math.max(1, Math.floor(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  // Brush interaction in data space so it works whatever the label gutter is.
  const tAt = (e: PointerEvent | MouseEvent) => {
    const x = e.clientX - canvas.getBoundingClientRect().left;
    return toT(((x - labelX) / Math.max(1, W - labelX)) * W);
  };
  const pxPerT = () => (cov ? (W - labelX) / (cov.t1 - cov.t0) : 1);
  let drag: { mode: 'pan' | 'l' | 'r' | 'new'; t: number; v0: number; v1: number } | null = null;
  const edge = (e: PointerEvent) => {
    const t = tAt(e);
    const v = view.value;
    const tol = 5 / pxPerT();
    if (Math.abs(t - v.t0) <= tol) return 'l';
    if (Math.abs(t - v.t1) <= tol) return 'r';
    if (t > v.t0 && t < v.t1) return 'pan';
    return 'new';
  };
  const pinUnder = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return e.clientY - r.top < PIN + 2 ? pinAt(pins, e.clientX - r.left, 5) : null;
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !trace.value) return;
    const pg = pinUnder(e);
    const a = analysis.value;
    if (pg && a) {
      tip.style.display = 'none';
      selectSpan(a.outliers[pg.slowest].span);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    drag = { mode: edge(e), t: tAt(e), v0: view.value.t0, v1: view.value.t1 };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) {
      const pg = pinUnder(e);
      if (pg) {
        showPinTip(pg, e);
        canvas.style.cursor = 'pointer';
        return;
      }
      tip.style.display = 'none';
      const m = trace.value ? edge(e) : 'new';
      canvas.style.cursor = m === 'l' || m === 'r' ? 'ew-resize' : m === 'pan' ? 'grab' : 'crosshair';
      return;
    }
    const t = tAt(e);
    const dr = drag;
    const d = t - dr.t;
    setViewNow(() => {
      if (dr.mode === 'pan') zoomTo(dr.v0 + d, dr.v1 + d);
      else if (dr.mode === 'l') zoomTo(Math.min(t, dr.v1 - 0.02), dr.v1);
      else if (dr.mode === 'r') zoomTo(dr.v0, Math.max(t, dr.v0 + 0.02));
      else if (Math.abs(d) * pxPerT() > 3) zoomTo(Math.min(t, dr.t), Math.max(t, dr.t));
    });
  };
  function showPinTip(g: PinGroup, e: PointerEvent) {
    const t = trace.value;
    const a = analysis.value;
    if (!t || !a) return;
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const o = a.outliers[g.slowest];
    const id = o.span;
    const dur = Number.isNaN(t.spans.dur[id]) ? fmtDur(spanEnd(t, id) - t.spans.start[id]) : fmtDur(t.spans.dur[id]);
    tip.innerHTML =
      (g.members.length > 1 ? `<div style="color:var(--text-2)">${g.members.length} slow calls here · slowest:</div>` : '') +
      `<div><span style="font:var(--fs-mono) var(--font-mono)">${esc(t.funcs.name[t.spans.func[id]])}</span>` +
      ` <span style="color:var(--text-2);font:var(--fs-mono) var(--font-mono)">${dur}</span></div>` +
      `<div style="color:var(--critical)">${esc(o.reason)}</div>` +
      `<div style="color:var(--text-3)">click to select</div>`;
    tip.style.display = 'block';
    const r = canvas.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.round(Math.max(4, Math.min(e.clientX - tw / 2, innerWidth - tw - 4)))}px`;
    tip.style.top = `${Math.round(r.bottom + 6 + th > innerHeight ? r.top - th - 6 : r.bottom + 6)}px`;
  }
  const onUp = (e: PointerEvent) => {
    // A click on empty strip (no drag) centres the view there.
    if (drag?.mode === 'new' && Math.abs(tAt(e) - drag.t) * pxPerT() <= 3) {
      const w = drag.v1 - drag.v0;
      zoomTo(drag.t - w / 2, drag.t + w / 2);
    }
    drag = null;
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('dblclick', (e) => {
    if (!pinUnder(e)) zoomAll();
  });
  canvas.addEventListener('pointerleave', () => {
    tip.style.display = 'none';
  });

  const disposers = [
    effect(() => {
      void trace.value; void analysis.value; void view.value; void shownView.value;
      invalidate();
    }),
    onSchemeChange(() => {
      pal = readPalette();
      invalidate();
    }),
  ];
  return () => {
    disposers.forEach((d) => d());
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    tip.remove();
    wrap.remove();
  };
}
