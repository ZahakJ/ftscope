// The timeline canvas: lanes of call boxes, painted from the pure layout in
// layout.ts. Scheme: wheel zooms about the pointer (pinch too), shift+wheel
// scrolls lanes vertically, horizontal wheel pans, drag pans both axes.

import { effect } from '@preact/signals';
import { F, type Trace } from '../../core/model';
import type { Analysis } from '../../core/api';
import {
  analysis, colorMode, hover, matches, select, selectSpan, selection, spanEnd, trace, view, zoomAll, zoomTo,
} from '../state';
import { fmtCount, fmtDur, fmtTime } from '../format';
import { immediate, setViewNow, shownView } from './shown';
import { mix, onSchemeChange, readPalette, type Palette } from './colors';
import {
  HEADER, LANE_GAP, buildIndex, coalesce, easeOut, gapLanes, hitTest, lerpView, layoutLanes, lowerBound, makeItems, ticks, upperBound, visibleRange,
  type Hit, type LaneBox, type TimelineIndex,
} from './layout';

const AXIS = 22;
const ANIM_MS = 150;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
type View = { t0: number; t1: number };

/** Rolling frame times, read by the dev harness. */
export const frameStats = { frames: 0, total: 0, max: 0, last: 0 };

export function mountTimeline(el: HTMLElement): () => void {
  // Our own positioned box: the host element's layout belongs to the shell.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden';
  el.append(wrap);
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;touch-action:none;cursor:default';
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:absolute;pointer-events:none;display:none;z-index:2;max-width:420px;padding:6px 8px;border:1px solid var(--line-strong);' +
    'border-radius:var(--radius);background:var(--surface-2);color:var(--text);font:var(--fs-small)/1.4 var(--font-ui);white-space:nowrap';
  wrap.append(canvas, tip);
  const ctx = canvas.getContext('2d')!;

  let pal = readPalette();
  const patterns = new Map<string, CanvasPattern>();
  let idx: TimelineIndex | null = null;
  let idxFor: Trace | null = null;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let scrollY = 0;
  let boxes: LaneBox[] = [];
  const expanded = new Set<number>();
  let items = makeItems();
  let dirty = true;
  let raf = 0;
  let mouse: { x: number; y: number } | null = null;
  // The view as painted: eases toward view.value (see shown.ts).
  let shown: View = view.value;
  let anim: { from: View; to: View; start: number } | null = null;
  let animTrace: Trace | null = null;
  let gl: (number[] | null)[] = [];
  const settle = () => {
    if (!anim) return;
    anim = null;
    shown = view.value;
    shownView.value = shown;
    invalidate();
  };

  const invalidate = () => {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  };

  function hatch(color: string): CanvasPattern {
    let p = patterns.get(color);
    if (!p) {
      const c = document.createElement('canvas');
      c.width = c.height = 6;
      const g = c.getContext('2d')!;
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, 6);
      g.lineTo(6, 0);
      g.moveTo(-1, 1);
      g.lineTo(1, -1);
      g.moveTo(5, 7);
      g.lineTo(7, 5);
      g.stroke();
      p = ctx.createPattern(c, 'repeat')!;
      patterns.set(color, p);
    }
    return p;
  }

  function ensureIndex(t: Trace): TimelineIndex {
    if (idxFor !== t) {
      idx = buildIndex(t);
      idxFor = t;
      gl = gapLanes(t, idx, Math.max(20, t.meta.duration * 0.002));
      expanded.clear();
      scrollY = 0;
    }
    return idx!;
  }

  const contentHeight = () => (boxes.length ? boxes[boxes.length - 1].top + boxes[boxes.length - 1].height : 0);
  const clampScroll = () => {
    scrollY = Math.max(0, Math.min(scrollY, contentHeight() - (H - AXIS) + 8));
  };
  const isZoomed = (t: Trace) => shown.t1 - shown.t0 < t.meta.duration * 0.98;

  function relayout(t: Trace) {
    const v = shown;
    const ix = ensureIndex(t);
    // Uncapped when everything fits on screen: the depth cap exists to share room, not to hide calls.
    boxes = layoutLanes(ix, v.t0, v.t1, pal.row, expanded, isZoomed(t), Infinity);
    if (contentHeight() > H - AXIS) {
      // Share the height among the lanes with something in view (stubs take a header only),
      // between 4 rows (enough to read the entry call) and 14.
      const live = boxes.filter((b) => b.rows > 0).length || 1;
      const room = H - AXIS - boxes.length * (HEADER + LANE_GAP);
      const cap = Math.max(4, Math.min(14, Math.floor(room / live / pal.row)));
      boxes = layoutLanes(ix, v.t0, v.t1, pal.row, expanded, isZoomed(t), cap);
    }
    clampScroll();
  }

  function colorOf(t: Trace, a: Analysis | null, id: number): string {
    if (colorMode.value === 'surprise') {
      const s = a ? a.surprise[id] : 0;
      return pal.heat[s >= 4 ? 4 : s >= 3 ? 3 : s >= 2 ? 2 : s >= 1 ? 1 : 0];
    }
    return pal.catFill[t.funcs.cat[t.spans.func[id]]] ?? pal.catFill[0];
  }
  function inkOf(t: Trace, a: Analysis | null, id: number): string {
    if (colorMode.value === 'surprise') {
      const s = a ? a.surprise[id] : 0;
      return pal.heatInk[s >= 4 ? 4 : s >= 3 ? 3 : s >= 2 ? 2 : s >= 1 ? 1 : 0];
    }
    return pal.catInk[t.funcs.cat[t.spans.func[id]]] ?? pal.text;
  }
  const keyOf = (t: Trace, a: Analysis | null) =>
    colorMode.value === 'surprise'
      ? (id: number) => {
          const s = a ? a.surprise[id] : 0;
          return s >= 4 ? 4 : Math.max(0, Math.floor(s));
        }
      : (id: number) => t.funcs.cat[t.spans.func[id]];

  function draw() {
    const t0ms = performance.now();
    const t = trace.value;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.surface1;
    ctx.fillRect(0, 0, W, H);
    if (!t || W < 2) return;
    const a = analysis.value;
    relayout(t);
    const ix = idx!;
    const { t0, t1 } = shown;
    const k = W / (t1 - t0);
    const R = pal.row;
    const gapsIn: number[] = [];
    t.gaps.forEach((g, i) => {
      if (g.ts >= t0 && g.ts <= t1) gapsIn.push(i);
    });
    const sp = t.spans;
    const m = matches.value;
    const sel = selection.value;
    const selFunc = sel?.kind === 'func' ? sel.id : -1;
    const selSpan = sel?.kind === 'span' ? sel.id : -1;
    const dimming = !!m || selFunc >= 0;
    const strong = (id: number) => (m ? m[sp.func[id]] === 1 : true) && (selFunc < 0 || sp.func[id] === selFunc);
    const key = keyOf(t, a);
    const hov = hover.value;
    let selRect: number[] | null = null;
    let hovRect: number[] | null = null;
    const monoFont = `12px ${pal.fontMono}`;
    ctx.textBaseline = 'middle';

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, AXIS, W, H - AXIS);
    ctx.clip();
    for (const b of boxes) {
      const y0 = AXIS + b.top - scrollY;
      if (y0 > H || y0 + b.height < AXIS) continue;
      const lane = ix.lanes[b.lane];
      const track = t.tracks[lane.track];
      // Header band: name, chevron when the lane is capped or expanded, switch ticks.
      ctx.fillStyle = pal.surface2;
      ctx.fillRect(0, y0, W, HEADER);
      ctx.fillStyle = pal.line;
      ctx.fillRect(0, y0 + HEADER - 1, W, 1);
      const sw = lane.switches;
      ctx.fillStyle = pal.text3;
      let lastX = -2;
      for (let i = lowerBound(sw, t0); i < sw.length && sw[i] <= t1; i++) {
        const x = Math.floor((sw[i] - t0) * k);
        if (x === lastX) continue;
        lastX = x;
        ctx.fillRect(x, y0 + HEADER - 5, 1, 4);
      }
      ctx.font = `11.5px ${pal.fontUi}`;
      const canExpand = b.capped || expanded.has(b.lane);
      const label = `${canExpand ? (expanded.has(b.lane) ? '▾ ' : '▸ ') : ''}${track.name}`;
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = pal.surface2;
      ctx.fillRect(0, y0, lw + 12, HEADER - 1);
      ctx.fillStyle = pal.text2;
      ctx.fillText(label, 6, y0 + HEADER / 2);
      {
        // Quiet stats after the name; the capped note after those.
        ctx.font = `10.5px ${pal.fontUi}`;
        let note = `${fmtCount(track.spans)} calls · ${ix.noDur ? 'no durations' : `${fmtDur(lane.busy)} traced`}`;
        if (b.capped) note += `  ·  ${b.depth - b.rows} more levels`;
        else if (b.rows === 0) note += '  ·  nothing in view';
        const nw = ctx.measureText(note).width;
        ctx.fillStyle = pal.surface2;
        ctx.fillRect(lw + 12, y0, nw + 10, HEADER - 1);
        ctx.fillStyle = pal.text3;
        ctx.fillText(note, lw + 16, y0 + HEADER / 2);
      }

      const rows = Math.min(b.rows, lane.rows.length);
      for (let d = 0; d < rows; d++) {
        const ry = y0 + HEADER + d * R;
        if (ry > H || ry + R < AXIS) continue;
        const row = lane.rows[d];
        items.n = 0;
        items = coalesce(row, t0, t1, W, items, key);
        for (let q = 0; q < items.n; q++) {
          const id = items.id[q];
          const run = items.kind[q] === 1;
          let xa = Math.round(items.x0[q]);
          let xb = Math.round(items.x1[q]);
          if (xa < -2) xa = -2;
          if (xb > W + 2) xb = W + 2;
          const wpx = xb - xa;
          const fw = ix.noDur ? Math.max(1, wpx) : wpx >= 3 ? wpx - 1 : Math.max(1, wpx);
          let isStrong = true;
          if (dimming) {
            isStrong = strong(id);
            if (run && !isStrong) for (let j = items.lo[q]; j < items.hi[q] && j < items.lo[q] + 32; j++) if (strong(row.ids[j])) { isStrong = true; break; }
          }
          ctx.globalAlpha = isStrong ? 1 : 0.25;
          if (ix.noDur && run) {
            // Tick density: more calls in a column, more opaque.
            const n = items.hi[q] - items.lo[q];
            ctx.globalAlpha *= Math.min(1, 0.35 + 0.15 * Math.log2(1 + n / Math.max(1, wpx)));
          }
          const f = sp.flags[id];
          ctx.fillStyle = colorOf(t, a, id);
          if (!run && f & (F.UNCLOSED | F.ORPHAN)) {
            const g = ctx.createLinearGradient(xa, 0, xa + fw, 0);
            const c = ctx.fillStyle as string;
            const clear = mix(c, pal.surface1, 0);
            g.addColorStop(0, f & F.ORPHAN ? clear : c);
            g.addColorStop(f & F.ORPHAN ? 0.6 : 0.4, c);
            g.addColorStop(1, f & F.UNCLOSED ? clear : c);
            ctx.fillStyle = g;
          }
          ctx.fillRect(xa, ry, fw, R - 1);
          if (!run && fw >= 3) {
            if (f & F.IRQ) {
              ctx.fillStyle = pal.cat[8];
              ctx.fillRect(xa, ry, fw, 2);
            }
            if (f & F.GAP) {
              ctx.fillStyle = hatch(pal.warn);
              ctx.fillRect(xa, ry, fw, R - 1);
            }
            if (a && a.outlier[id]) {
              ctx.fillStyle = pal.critical;
              ctx.beginPath();
              ctx.moveTo(xa + fw - 7, ry);
              ctx.lineTo(xa + fw, ry);
              ctx.lineTo(xa + fw, ry + 7);
              ctx.fill();
            }
            if (fw >= 40) {
              const name = t.funcs.name[sp.func[id]];
              const dur = Number.isNaN(sp.dur[id]) ? '' : fmtDur(sp.dur[id]);
              const vis0 = Math.max(xa, 0) + 4;
              // Labels live on the solid part: stop at the first off-CPU stretch inside the box.
              let solid = Math.min(xa + fw, W);
              const lo2 = lane.off;
              const bs = sp.start[id];
              let oj = lowerBound(lo2, bs) & ~1;
              if (oj < lo2.length && lo2[oj + 1] <= bs) oj += 2;
              if (oj < lo2.length && lo2[oj] < bs + (Number.isNaN(sp.dur[id]) ? 0 : sp.dur[id])) solid = Math.min(solid, Math.round((lo2[oj] - t0) * k));
              const room = solid - vis0 - 4;
              ctx.font = monoFont;
              // Light text on the two brightest heat steps would vanish; they take the background colour.
              const ink = inkOf(t, a, id);
              const onText = ink === pal.text;
              ctx.fillStyle = ink;
              const nw = ctx.measureText(name).width;
              const dw = dur ? ctx.measureText(dur).width : 0;
              if (room > 24) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(vis0, ry, room, R);
                ctx.clip();
                ctx.fillText(name, vis0, ry + R / 2);
                if (dur && room >= nw + dw + 14) {
                  ctx.fillStyle = onText ? pal.text2 : ink;
                  if (!onText) ctx.globalAlpha *= 0.72;
                  ctx.fillText(dur, vis0 + room - dw, ry + R / 2);
                }
                ctx.restore();
              }
            }
          }
          if (a && run && a.outlier[id]) {
            ctx.fillStyle = pal.critical;
            ctx.fillRect(xa, ry, Math.max(2, fw), 2);
          }
          ctx.globalAlpha = 1;
          if (id === selSpan && !run) selRect = [xa, ry, fw, R - 1];
          if (id === hov && !run) hovRect = [xa, ry, fw, R - 1];
        }
      }
      // Off-CPU: the task slept here; hollow out every row that was open.
      const off = lane.off;
      for (let i = lowerBound(off, t0) & ~1; i < off.length; i += 2) {
        if (off[i] > t1) break;
        if (off[i + 1] < t0) continue;
        const xa = Math.round((off[i] - t0) * k);
        const xb = Math.round((off[i + 1] - t0) * k);
        if (xb - xa < 1) continue;
        const mid = (off[i] + off[i + 1]) / 2;
        let open = 0;
        while (open < rows) {
          const r = lane.rows[open];
          const j = upperBound(r.s, mid) - 1;
          if (j < 0 || r.e[j] < mid) break;
          open++;
        }
        if (!open) continue;
        const ry = y0 + HEADER;
        // Opaque: labels drawn on the boxes beneath must not show through as stray characters.
        ctx.fillStyle = pal.surface1;
        ctx.fillRect(xa, ry, xb - xa, open * R - 1);
        ctx.fillStyle = hatch(pal.lineStrong);
        ctx.fillRect(xa, ry, xb - xa, open * R - 1);
        if (xb - xa > 60) {
          ctx.fillStyle = pal.text3;
          ctx.font = `11.5px ${pal.fontUi}`;
          ctx.fillText(`off-CPU ${fmtDur(off[i + 1] - off[i])}`, Math.max(xa, 0) + 4, ry + (open - 0.5) * R);
        }
      }
      // Events: a small mark at their depth row; one per pixel column at most.
      if (rows > 0) {
        const ev = lane.events;
        const ets = t.events.ts;
        let lo = 0;
        let hi = ev.length;
        while (lo < hi) {
          const mm = (lo + hi) >>> 1;
          if (ets[ev[mm]] < t0) lo = mm + 1;
          else hi = mm;
        }
        let end = lo;
        hi = ev.length;
        while (end < hi) {
          const mm = (end + hi) >>> 1;
          if (ets[ev[mm]] <= t1) end = mm + 1;
          else hi = mm;
        }
        // Too dense to mark one by one: a tick per pixel column in the header band instead.
        const dense = end - lo > W / 12;
        ctx.fillStyle = pal.text2;
        let px = -9;
        for (let i = lo; i < end; i++) {
          const x = Math.round((ets[ev[i]] - t0) * k);
          if (x - px < (dense ? 1 : 4)) continue;
          px = x;
          if (dense) {
            ctx.fillRect(x, y0 + 1, 1, 3);
            continue;
          }
          const s = t.events.span[ev[i]];
          const d = Math.min(s >= 0 ? sp.depth[s] + 1 : 0, rows - 1);
          const ey = y0 + HEADER + d * R + R - 1;
          ctx.beginPath();
          ctx.moveTo(x, ey - 6);
          ctx.lineTo(x + 3.5, ey);
          ctx.lineTo(x - 3.5, ey);
          ctx.fill();
        }
      }
      // Lost events: hatched over the lanes that were running on that CPU at the time.
      if (gapsIn.length) {
        for (const gi of gapsIn) {
          const ls = gl[gi];
          if (ls && !ls.includes(b.lane)) continue;
          const x = Math.round((t.gaps[gi].ts - t0) * k);
          // Below the header (kept readable) unless the lane is a stub.
          const gy = rows > 0 ? y0 + HEADER : y0;
          const h = y0 + b.height - LANE_GAP - gy;
          // A tinted, hatched band with a solid seam: distinct from the grey off-CPU hatch.
          ctx.fillStyle = pal.warn;
          ctx.globalAlpha = 0.22;
          ctx.fillRect(x - 4, gy, 9, h);
          ctx.globalAlpha = 1;
          ctx.fillStyle = hatch(pal.warn);
          ctx.fillRect(x - 4, gy, 9, h);
          ctx.fillStyle = pal.warn;
          ctx.fillRect(x, gy, 1, h);
        }
      }
    }
    if (hovRect && hovRect !== selRect) {
      ctx.strokeStyle = pal.text3;
      ctx.lineWidth = 1;
      ctx.strokeRect(hovRect[0] + 0.5, hovRect[1] + 0.5, hovRect[2] - 1, hovRect[3] - 1);
    }
    if (selRect) {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(selRect[0] + 1, selRect[1] + 1, Math.max(selRect[2] - 2, 1), selRect[3] - 2);
    }
    ctx.restore();
    drawAxis(t, t0, t1);
    const dt = performance.now() - t0ms;
    frameStats.frames++;
    frameStats.total += dt;
    frameStats.last = dt;
    if (dt > frameStats.max) frameStats.max = dt;
  }

  function drawAxis(t: Trace, t0: number, t1: number) {
    ctx.fillStyle = pal.surface1;
    ctx.fillRect(0, 0, W, AXIS);
    ctx.fillStyle = pal.line;
    ctx.fillRect(0, AXIS - 1, W, 1);
    const { at } = ticks(t0, t1, W);
    const k = W / (t1 - t0);
    ctx.font = `11.5px ${pal.fontMono}`;
    ctx.textBaseline = 'middle';
    const span = fmtDur(t1 - t0);
    const recon = t.meta.clock === 'reconstructed' ? 'time reconstructed from durations  ·  ' : '';
    const right = `${recon}${span} visible`;
    const rw = ctx.measureText(right).width;
    for (const d of at) {
      const x = Math.round(d * k);
      const label = `+${fmtDur(d)}`;
      ctx.fillStyle = pal.line;
      ctx.fillRect(x, AXIS - 6, 1, 5);
      if (x + 3 + ctx.measureText(label).width > W - rw - 16) continue;
      ctx.fillStyle = pal.text3;
      ctx.fillText(label, x + 3, AXIS / 2 - 1);
    }
    ctx.fillStyle = pal.surface1;
    ctx.fillRect(W - rw - 14, 0, rw + 14, AXIS - 1);
    ctx.fillStyle = recon ? pal.warn : pal.text2;
    ctx.fillText(right, W - rw - 6, AXIS / 2 - 1);
    // Selected call: a faint bracket over its extent along the axis' foot.
    const sel = selection.value;
    if (sel?.kind === 'span' && sel.id < t.spans.n) {
      const xa = Math.round((t.spans.start[sel.id] - t0) * k);
      const xb = Math.max(xa + 1, Math.round((spanEnd(t, sel.id) - t0) * k));
      if (xb >= 0 && xa <= W) {
        const a0 = Math.max(xa, -1);
        const b0 = Math.min(xb, W + 1);
        ctx.fillStyle = pal.accent;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(a0, AXIS - 6, b0 - a0, 5);
        ctx.globalAlpha = 0.7;
        ctx.fillRect(a0, AXIS - 2, b0 - a0, 1);
        if (xa >= 0) ctx.fillRect(xa, AXIS - 7, 1, 6);
        if (xb <= W) ctx.fillRect(xb - 1, AXIS - 7, 1, 6);
        ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = pal.surface1;
    const left = `@ ${fmtDur(t0)}`;
    ctx.fillRect(0, 0, ctx.measureText(left).width + 10, AXIS - 1);
    ctx.fillStyle = pal.text2;
    ctx.fillText(left, 4, AXIS / 2 - 1);
  }

  function frame(now: number) {
    raf = 0;
    if (anim) {
      const p = (now - anim.start) / ANIM_MS;
      shown = p >= 1 ? anim.to : lerpView(anim.from, anim.to, easeOut(p));
      if (p >= 1) anim = null;
      shownView.value = shown;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    draw();
    if (anim) raf = requestAnimationFrame(frame);
  }

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

  // ---- interaction ----------------------------------------------------------

  const hitAt = (x: number, y: number): Hit => {
    const t = trace.value;
    if (!t || !idx || y < AXIS) return { kind: 'none' };
    const v = shown;
    return hitTest(idx, boxes, pal.row, v.t0, v.t1, W, x, y - AXIS + scrollY);
  };

  function zoomAbout(x: number, factor: number) {
    const v = view.value;
    const tx = v.t0 + ((v.t1 - v.t0) * x) / W;
    zoomTo(tx - (tx - v.t0) * factor, tx + (v.t1 - tx) * factor);
  }
  function pan(dxPx: number) {
    const v = view.value;
    const dt = ((v.t1 - v.t0) * dxPx) / W;
    zoomTo(v.t0 + dt, v.t1 + dt);
  }

  function showTip(h: Hit, x: number, y: number) {
    const t = trace.value!;
    const a = analysis.value;
    const sp = t.spans;
    let html = '';
    const mono = (s: string) => `<span style="font:var(--fs-mono) var(--font-mono)">${s}</span>`;
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    if (h.kind === 'span' || h.kind === 'run') {
      const id = h.kind === 'span' ? h.id : h.dom;
      const name = esc(t.funcs.name[sp.func[id]]);
      const dur = sp.flags[id] & F.NO_DUR
        ? 'no duration (function tracer)'
        : Number.isNaN(sp.dur[id])
          ? `still running at the end (${fmtDur(spanEnd(t, id) - sp.start[id])}+)`
          : fmtDur(sp.dur[id]);
      const self = a && !Number.isNaN(a.self[id]) ? ` · self ${fmtDur(a.self[id])}` : '';
      const off = a && a.off[id] > 0 ? ` · off-CPU ${fmtDur(a.off[id])}` : '';
      html =
        (h.kind === 'run' ? `<div style="color:var(--text-2)">×${h.hi - h.lo} calls here · largest:</div>` : '') +
        `<div>${mono(name)}</div><div style="color:var(--text-2)">${mono(dur + self + off)}</div>` +
        `<div style="color:var(--text-3)">${esc(t.tracks[t.trackOf[id]].name)} · at ${mono(fmtDur(sp.start[id]))}` +
        `${t.meta.clock === 'reconstructed' ? ' (reconstructed)' : ''}</div>` +
        (a && a.outlier[id] ? `<div style="color:var(--critical)">▲ slow among its peers</div>` : '');
    }
    if (!html) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = html;
    placeTip(x, y);
  }
  /** Below-right of the pointer; flipped to the other side when it would cross an edge. */
  function placeTip(x: number, y: number) {
    tip.style.display = 'block';
    tip.style.maxWidth = `${Math.max(160, Math.min(420, W - 8))}px`;
    tip.style.whiteSpace = W < 440 ? 'normal' : 'nowrap';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = x + 14 + tw > W - 4 ? x - 14 - tw : x + 14;
    const top = y + 16 + th > H - 4 ? y - 10 - th : y + 16;
    tip.style.left = `${Math.round(Math.max(4, left))}px`;
    tip.style.top = `${Math.round(Math.max(4, top))}px`;
  }
  /** The lost-event gap drawn under (x, y), if any. */
  function gapAt(x: number, y: number) {
    const t = trace.value;
    if (!t || !t.gaps.length || y < AXIS) return null;
    const cy = y - AXIS + scrollY;
    const b = boxes.find((q) => cy >= q.top && cy < q.top + q.height - LANE_GAP);
    if (!b) return null;
    const k = W / (shown.t1 - shown.t0);
    let best = -1;
    let bd = 5;
    t.gaps.forEach((g, i) => {
      const d = Math.abs((g.ts - shown.t0) * k - x);
      if (d < bd && (!gl[i] || gl[i]!.includes(b.lane))) {
        bd = d;
        best = i;
      }
    });
    return best >= 0 ? t.gaps[best] : null;
  }

  /** Event marks under the pointer: the same geometry the draw pass uses. Several ids = a coalesced mark. */
  function eventsAt(x: number, y: number): number[] {
    const t = trace.value;
    if (!t || !idx || !t.events.n || y < AXIS) return [];
    const cy = y - AXIS + scrollY;
    const b = boxes.find((q) => cy >= q.top && cy < q.top + q.height - LANE_GAP);
    if (!b) return [];
    const lane = idx.lanes[b.lane];
    const rows = Math.min(b.rows, lane.rows.length);
    if (rows <= 0) return [];
    const ev = lane.events;
    const ets = t.events.ts;
    const t0 = shown.t0;
    const t1 = shown.t1;
    const k = W / (t1 - t0);
    const lb = (v: number, from = 0) => {
      let a = from;
      let z = ev.length;
      while (a < z) {
        const m = (a + z) >>> 1;
        if (ets[ev[m]] < v) a = m + 1;
        else z = m;
      }
      return a;
    };
    const lo = lb(t0 - 6 / k);
    const inView = Math.max(0, lb(t1 + 1e-9) - lb(t0));
    const dense = inView > W / 12;
    const R = pal.row;
    const out: number[] = [];
    for (let i = lo; i < ev.length; i++) {
      const ex = (ets[ev[i]] - t0) * k;
      if (ex > x + 5) break;
      if (Math.abs(ex - x) > 4.5) continue;
      if (dense) {
        if (cy - b.top <= 6) out.push(ev[i]);
        continue;
      }
      const s = t.events.span[ev[i]];
      const d = Math.min(s >= 0 ? t.spans.depth[s] + 1 : 0, rows - 1);
      const ey = b.top + HEADER + d * R + R - 1;
      if (cy >= ey - 8 && cy <= ey + 1) out.push(ev[i]);
    }
    return out;
  }

  let drag: { x: number; y: number; moved: boolean; t0: number; t1: number; sy: number } | null = null;
  const pos = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    settle();
    const { x } = pos(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.shiftKey && !e.ctrlKey) {
      scrollY += dy || dx;
      clampScroll();
      invalidate();
    } else if (Math.abs(dx) > Math.abs(dy)) setViewNow(() => pan(dx));
    else setViewNow(() => zoomAbout(x, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015))));
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    settle();
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    drag = { ...p, moved: false, t0: view.value.t0, t1: view.value.t1, sy: scrollY };
  };
  const onMove = (e: PointerEvent) => {
    const p = pos(e);
    mouse = p;
    if (drag) {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        canvas.style.cursor = 'grabbing';
        tip.style.display = 'none';
      }
      if (drag.moved) {
        const dt = ((drag.t1 - drag.t0) * dx) / W;
        setViewNow(() => zoomTo(drag!.t0 - dt, drag!.t1 - dt));
        scrollY = drag.sy - dy;
        clampScroll();
        invalidate();
        return;
      }
    }
    const h = hitAt(p.x, p.y);
    const id = h.kind === 'span' ? h.id : -1;
    if (hover.value !== id) hover.value = id;
    const g = gapAt(p.x, p.y);
    if (g) {
      canvas.style.cursor = 'default';
      tip.innerHTML = `<div style="color:var(--warn)">${fmtCount(g.lost)} events lost here on CPU ${g.cpu}</div>` +
        `<div style="color:var(--text-3)">the kernel's buffer overflowed; calls across this point may be cut</div>`;
      placeTip(p.x, p.y);
      return;
    }
    const evs = eventsAt(p.x, p.y);
    if (evs.length) {
      const t = trace.value!;
      const e0 = evs[0];
      const span = shown.t1 - shown.t0;
      canvas.style.cursor = evs.length > 1 ? 'zoom-in' : 'pointer';
      tip.innerHTML = evs.length > 1
        ? `<div><span style="font:var(--fs-mono) var(--font-mono)">${fmtCount(evs.length)} events</span></div>` +
          `<div style="color:var(--text-3)">${[...new Set(evs.map((e) => t.eventNames[t.events.name[e]]))].slice(0, 4).join(', ')} · click to zoom in</div>`
        : `<div><span style="font:var(--fs-mono) var(--font-mono)">${t.eventNames[t.events.name[e0]]}</span></div>` +
          `<div style="color:var(--text-2)"><span style="font:var(--fs-mono) var(--font-mono)">${fmtTime(t.events.ts[e0], span)}</span> · event</div>`;
      placeTip(p.x, p.y);
      return;
    }
    canvas.style.cursor = h.kind === 'header' ? 'pointer' : h.kind === 'run' ? 'zoom-in' : 'default';
    showTip(h, p.x, p.y);
  };
  const onUp = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    canvas.style.cursor = 'default';
    if (!d || d.moved) return;
    const p = pos(e);
    const evs = eventsAt(p.x, p.y);
    if (evs.length === 1) {
      select({ kind: 'event', id: evs[0] });
      return;
    }
    if (evs.length > 1) {
      const t = trace.value!;
      const a0 = t.events.ts[evs[0]];
      const a1 = t.events.ts[evs[evs.length - 1]];
      const w = Math.max(a1 - a0, (shown.t1 - shown.t0) / 50, 0.05);
      zoomTo(a0 - w * 0.5, a1 + w * 0.5);
      return;
    }
    const h = hitAt(p.x, p.y);
    if (h.kind === 'span') selectSpan(h.id, { reveal: false });
    else if (h.kind === 'run') {
      const w = Math.max(h.t1 - h.t0, 0.05);
      zoomTo(h.t0 - w * 0.1, h.t1 + w * 0.1);
    } else if (h.kind === 'header') {
      if (expanded.has(h.lane)) expanded.delete(h.lane);
      else expanded.add(h.lane);
      invalidate();
    } else selection.value = null;
  };
  const onDbl = (e: MouseEvent) => {
    const t = trace.value;
    const p = pos(e);
    const h = hitAt(p.x, p.y);
    if (t && h.kind === 'span') {
      const s = t.spans.start[h.id];
      const w = Math.max(spanEnd(t, h.id) - s, 0.05);
      zoomTo(s - w * 0.05, s + w * 1.05);
    }
  };
  const onLeave = () => {
    mouse = null;
    tip.style.display = 'none';
    if (hover.value !== -1) hover.value = -1;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && !el.contains(ae)) return;
    if (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
    const t = trace.value;
    if (!t || el.offsetParent === null) return;
    const cx = mouse ? mouse.x : W / 2;
    switch (e.key) {
      case 'w': zoomAbout(cx, 0.7); break;
      case 's': zoomAbout(cx, 1 / 0.7); break;
      case 'a': pan(-W * 0.2); break;
      case 'd': pan(W * 0.2); break;
      case '0': zoomAll(); break;
      case 'f': {
        const sel = selection.value;
        let s = Infinity;
        let en = -Infinity;
        if (sel?.kind === 'span') {
          s = t.spans.start[sel.id];
          en = spanEnd(t, sel.id);
        } else if (sel?.kind === 'func') {
          // Every call of the function: one pass on a key press.
          const fn = t.spans.func;
          for (let i = 0; i < t.spans.n; i++) {
            if (fn[i] !== sel.id) continue;
            if (t.spans.start[i] < s) s = t.spans.start[i];
            const e2 = spanEnd(t, i);
            if (e2 > en) en = e2;
          }
        }
        if (!(en >= s)) return;
        const w = Math.max(en - s, 0.05);
        zoomTo(s - w * 0.05, s + w * 1.05);
        break;
      }
      default: return;
    }
    e.preventDefault();
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('pointerleave', onLeave);
  window.addEventListener('keydown', onKey);

  // Follow selection made elsewhere: bring the selected span's lane into view.
  let lastSel: unknown = null;
  const disposers = [
    // Ease toward view changes made by keys or other panels; wheel/drag and new traces snap.
    effect(() => {
      const v = view.value;
      const t = trace.value;
      if (t !== animTrace || immediate.next || reducedMotion() || (v.t0 === shown.t0 && v.t1 === shown.t1)) {
        animTrace = t;
        anim = null;
        shown = v;
      } else anim = { from: shown, to: v, start: performance.now() };
      shownView.value = shown;
      invalidate();
    }),
    effect(() => {
      void trace.value; void analysis.value; void view.value; void colorMode.value; void matches.value; void hover.value;
      const sel = selection.value;
      const t = trace.value;
      if (sel !== lastSel && sel?.kind === 'span' && t) {
        lastSel = sel;
        relayout(t);
        const lane = ensureIndex(t).lanes.findIndex((l) => l.track === t.trackOf[sel.id]);
        const b = boxes[lane];
        if (b) {
          const y = b.top + HEADER + Math.min(t.spans.depth[sel.id], b.rows - 1) * pal.row;
          if (y < scrollY || y + pal.row > scrollY + H - AXIS) scrollY = Math.max(0, y - (H - AXIS) / 3);
          clampScroll();
        }
      }
      lastSel = sel;
      invalidate();
    }),
    onSchemeChange(() => {
      pal = readPalette();
      patterns.clear();
      invalidate();
    }),
  ];

  return () => {
    disposers.forEach((d) => d());
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    wrap.remove();
  };
}

export { visibleRange, LANE_GAP };
