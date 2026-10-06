// "Beside a typical call": the selected call and its median peer as two miniature icicles on one time scale.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { F, type Trace } from '../../core/model';
import { selectSpan } from '../state';
import { fmtCount, fmtDur } from '../format';
import { onSchemeChange, readPalette, type Palette } from '../timeline/colors';
import { boxAt, flatten, scales, toPixels, typicalPeer, type MiniTree, type PxBox } from './compare';

const H = 112;
const LABEL = 14; // label strip above each chart
const CHART = 42;
const TOP_A = LABEL;
const TOP_B = LABEL + CHART + LABEL;
const MAX_ROWS = 10;

interface Geo { boxes: [PxBox[], PxBox[]]; rh: number; k: [number, number] }

export function Compare({ t, id, peers }: { t: Trace; id: number; peers: Int32Array }) {
  const peer = useMemo(() => typicalPeer(t, peers, id), [t, peers, id]);
  const [same, setSame] = useState(true);
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const trees = useMemo<[MiniTree, MiniTree] | null>(() => (peer < 0 ? null : [flatten(t, id, MAX_ROWS), flatten(t, peer, MAX_ROWS)]), [t, id, peer]);
  const geo = useRef<Geo | null>(null);
  const hov = useRef<{ c: 0 | 1; b: PxBox } | null>(null);
  const draw = useRef<() => void>(() => {});

  useEffect(() => {
    const c = cv.current;
    if (!c || !trees) return;
    let pal: Palette = readPalette();
    const patterns = new Map<string, CanvasPattern>();
    const hatch = (ctx: CanvasRenderingContext2D, color: string) => {
      let p = patterns.get(color);
      if (!p) {
        const h = document.createElement('canvas');
        h.width = h.height = 6;
        const g = h.getContext('2d')!;
        g.strokeStyle = color;
        g.beginPath();
        g.moveTo(0, 6); g.lineTo(6, 0); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(5, 7); g.lineTo(7, 5);
        g.stroke();
        p = ctx.createPattern(h, 'repeat')!;
        patterns.set(color, p);
      }
      return p;
    };
    const paint = () => {
      const W = c.clientWidth;
      if (!W) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const [ta, tb] = trees;
      const k = scales(ta.dur, tb.dur, W, same);
      const rows = Math.max(ta.rows, tb.rows, 1);
      const rh = Math.max(2, Math.min(10, Math.floor(CHART / rows)));
      const boxes: [PxBox[], PxBox[]] = [toPixels(ta, k[0]), toPixels(tb, k[1])];
      geo.current = { boxes, rh, k };
      ctx.textBaseline = 'middle';
      ctx.font = `11px ${pal.fontUi}`;
      const label = (y: number, name: string, dur: string, note: string) => {
        ctx.fillStyle = pal.text3;
        ctx.fillText(name, 0, y + LABEL / 2 - 1);
        let x = ctx.measureText(name + ' ').width;
        ctx.font = `11px ${pal.fontMono}`;
        ctx.fillStyle = pal.text2;
        ctx.fillText(dur, x, y + LABEL / 2 - 1);
        x += ctx.measureText(dur + ' ').width;
        ctx.font = `11px ${pal.fontUi}`;
        ctx.fillStyle = pal.text3;
        if (note) ctx.fillText(note, x + 4, y + LABEL / 2 - 1);
      };
      const ratio = ta.dur / Math.max(tb.dur, 1e-9);
      const note = ratio >= 1.5 ? `· ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× longer than typical` : ratio <= 1 / 1.5 ? `· ${(1 / ratio).toFixed(1)}× shorter than typical` : '';
      label(0, 'this call', fmtDur(ta.dur), ta.total > ta.boxes.length ? `· showing the first ${fmtCount(ta.boxes.length)} of ${fmtCount(ta.total)} calls` : note);
      label(TOP_B - LABEL, 'a typical call', fmtDur(tb.dur), same ? '' : '· stretched to fit');
      const chart = (tree: MiniTree, bx: PxBox[], y0: number, kk: number, which: 0 | 1) => {
        // Baseline hairline: the whole width is the time this chart is measured against.
        ctx.fillStyle = pal.line;
        ctx.fillRect(0, y0 + CHART - 1, W, 1);
        for (const b of bx) {
          const x = Math.floor(b.px0);
          const w = Math.max(1, Math.round(b.px1) - x - (b.px1 - b.px0 >= 3 ? 1 : 0));
          const y = y0 + b.row * rh;
          const f = t.spans.flags[b.id];
          ctx.fillStyle = pal.catFill[t.funcs.cat[t.spans.func[b.id]]] ?? pal.catFill[0];
          ctx.globalAlpha = b.n > 1 ? 0.7 : 1;
          ctx.fillRect(x, y, w, rh - 1);
          ctx.globalAlpha = 1;
          if (f & F.IRQ && w >= 2) {
            ctx.fillStyle = pal.cat[8];
            ctx.fillRect(x, y, w, Math.min(2, rh - 1));
          }
        }
        // Off-CPU: hollow over the boxes that were open while the task slept.
        const off = tree.off;
        for (let i = 0; i < off.length; i += 2) {
          const xa = Math.floor(off[i] / kk);
          const xb = Math.ceil(off[i + 1] / kk);
          if (xb - xa < 1) continue;
          for (const b of bx) {
            if (b.n > 1 || b.px1 <= xa || b.px0 >= xb) continue;
            const a0 = Math.max(xa, Math.floor(b.px0));
            const a1 = Math.min(xb, Math.round(b.px1) - 1);
            if (a1 <= a0) continue;
            const y = y0 + b.row * rh;
            ctx.fillStyle = pal.surface1;
            ctx.fillRect(a0, y, a1 - a0, rh - 1);
            ctx.fillStyle = hatch(ctx, pal.lineStrong);
            ctx.fillRect(a0, y, a1 - a0, rh - 1);
          }
        }
        const h = hov.current;
        if (h && h.c === which) {
          const b = h.b;
          ctx.strokeStyle = pal.text2;
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.floor(b.px0) + 0.5, y0 + b.row * rh + 0.5, Math.max(1, Math.round(b.px1) - Math.floor(b.px0)) - 1, rh - 2);
        }
      };
      chart(ta, boxes[0], TOP_A, k[0], 0);
      chart(tb, boxes[1], TOP_B, k[1], 1);
    };
    draw.current = paint;
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    const off = onSchemeChange(() => {
      pal = readPalette();
      patterns.clear();
      paint();
    });
    return () => {
      ro.disconnect();
      off();
    };
  }, [trees, same, t]);

  if (!trees) return null;

  const hit = (e: MouseEvent): { c: 0 | 1; b: PxBox } | null => {
    const g = geo.current;
    const c = cv.current;
    if (!g || !c) return null;
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const which: 0 | 1 = y >= TOP_B - LABEL ? 1 : 0;
    const top = which ? TOP_B : TOP_A;
    if (y < top) return null;
    const b = boxAt(g.boxes[which], x, Math.floor((y - top) / g.rh));
    if (b) return { c: which, b };
    // The typical call is often a sliver: anywhere on its band near it counts.
    if (which === 1) {
      const root = g.boxes[1][0];
      if (root && x <= Math.max(root.px1, 6) + 6) return { c: 1, b: root };
    }
    return null;
  };
  const onMove = (e: MouseEvent) => {
    const h = hit(e);
    const el = tip.current!;
    const prev = hov.current;
    hov.current = h;
    if (prev?.b !== h?.b) draw.current();
    cv.current!.style.cursor = h ? 'pointer' : 'default';
    if (!h) {
      el.style.display = 'none';
      return;
    }
    const sid = h.b.id;
    const d = t.spans.dur[sid];
    el.innerHTML = '';
    const n = document.createElement('div');
    n.className = 'insp-cmp-tip-name';
    n.textContent = h.b.n > 1 ? `${fmtCount(h.b.n)} calls` : t.funcs.name[t.spans.func[sid]];
    const s = document.createElement('div');
    s.className = 'insp-cmp-tip-sub';
    s.textContent = h.b.n > 1 ? 'too small to draw apart' : `${Number.isFinite(d) ? fmtDur(d) : 'no duration'}${h.c === 1 && sid === peer ? ' · the typical call' : ''}`;
    el.append(n, s);
    el.style.display = 'block';
    const wr = wrap.current!.getBoundingClientRect();
    const x = e.clientX - wr.left;
    const left = Math.min(Math.max(0, x + 10), wr.width - el.offsetWidth);
    el.style.left = `${Math.max(0, left)}px`;
    el.style.top = `${e.clientY - wr.top + 14}px`;
  };
  const onLeave = () => {
    tip.current!.style.display = 'none';
    if (hov.current) {
      hov.current = null;
      draw.current();
    }
  };
  const onClick = (e: MouseEvent) => {
    const h = hit(e);
    if (!h) return;
    selectSpan(h.c === 1 ? peer : h.b.id);
  };

  return (
    <section class="insp-cmp">
      <div class="insp-label-row">
        <div class="insp-label">Beside a typical call</div>
        <span>
          <button class={'insp-mini' + (same ? ' is-on' : '')} title="Both calls at one µs-per-pixel: the typical call is drawn as small as it is" onClick={() => setSame(true)}>same scale</button>
          <button class={'insp-mini' + (same ? '' : ' is-on')} title="Each call stretched to the full width, to compare shapes" onClick={() => setSame(false)}>each to fit</button>
        </span>
      </div>
      <div class="insp-cmp-wrap" ref={wrap}>
        <canvas ref={cv} class="insp-cmp-cv" style={{ height: H + 'px' }} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} />
        <div class="insp-cmp-tip" ref={tip} />
      </div>
    </section>
  );
}
