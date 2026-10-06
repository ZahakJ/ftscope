import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Inspector } from './inspector';
import { Brief } from './shell/brief';
import { Functions } from './shell/functions';
import { installKeys } from './shell/keys';
import { installInputs, loadUrl, markReady, onNextReady } from './shell/load';
import { Empty, Failed, Help, Loading } from './shell/screens';
import { TopBar } from './shell/topbar';
import { restoreHash, syncHash } from './shell/url';
import { load, leftTab, mode } from './state';
import { Story } from './story';
import { mountOverview, mountTimeline } from './timeline';

const LS = 'ftscope.panels';
interface Panels {
  left: number;
  right: number;
  leftOpen: boolean;
  rightOpen: boolean;
}
function readPanels(): Panels {
  const d: Panels = { left: 340, right: 360, leftOpen: true, rightOpen: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(LS) ?? '{}') };
  } catch {
    return d;
  }
}
function savePanels(p: Panels): void {
  try {
    localStorage.setItem(LS, JSON.stringify(p));
  } catch {
    /* storage blocked: widths just are not remembered */
  }
}

function Mount({ fn, class: cls, hidden }: { fn: (el: HTMLElement) => () => void; class: string; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => fn(ref.current!), [fn]);
  return <div ref={ref} class={cls} hidden={hidden} />;
}

/** Drag the inner edge of a side panel. `side` is which panel the edge belongs to. */
function Resizer({ side, panels }: { side: 'left' | 'right'; panels: { value: Panels } }) {
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = panels.value[side];
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * (side === 'left' ? 1 : -1);
      panels.value = { ...panels.value, [side]: Math.round(Math.max(200, Math.min(640, w0 + dx))) };
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      savePanels(panels.value);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const open = side === 'left' ? panels.value.leftOpen : panels.value.rightOpen;
  const toggle = () => {
    panels.value = side === 'left' ? { ...panels.value, leftOpen: !open } : { ...panels.value, rightOpen: !open };
    savePanels(panels.value);
  };
  return (
    <div class={`resizer resizer-${side}` + (open ? '' : ' closed')} onPointerDown={open ? onDown : undefined}>
      <button
        class="edge-toggle"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
        title={`${open ? 'Hide' : 'Show'} ${side === 'left' ? 'the brief' : 'the inspector'} (${side === 'left' ? ',' : '.'})`}
        aria-label={`${open ? 'Hide' : 'Show'} ${side} panel`}
      >
        {(side === 'left') === open ? '‹' : '›'}
      </button>
    </div>
  );
}

function Workspace({ panels }: { panels: { value: Panels } }) {
  const p = panels.value;
  const cols = `${p.leftOpen ? p.left + 'px' : '0px'} minmax(0, 1fr) ${p.rightOpen ? p.right + 'px' : '0px'}`;
  return (
    <div class={'workspace' + (p.rightOpen ? '' : ' right-closed')} style={{ '--cols': cols } as Record<string, string>}>
      <Mount fn={mountOverview} class="overview" />
      <aside class="left" hidden={!p.leftOpen} aria-label="Brief and functions">
        <div class="tabs" role="tablist">
          {(['brief', 'functions'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={leftTab.value === k} onClick={() => (leftTab.value = k)}>
              {k === 'brief' ? 'Brief' : 'Functions'}
            </button>
          ))}
        </div>
        <div class="left-body">{leftTab.value === 'brief' ? <Brief /> : <Functions />}</div>
      </aside>
      <Resizer side="left" panels={panels} />
      <main class="main">
        <Mount fn={mountTimeline} class="timeline-host" hidden={mode.value !== 'timeline'} />
        <div class="story-host" hidden={mode.value !== 'story'}>
          <Story />
        </div>
      </main>
      <Resizer side="right" panels={panels} />
      <aside class="right" hidden={!p.rightOpen} aria-label="Inspector">
        <Inspector />
      </aside>
    </div>
  );
}

export function App() {
  const panels = useSignal<Panels>(readPanels());
  const dragging = useSignal(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offInputs = installInputs((on) => (dragging.value = on));
    const offKeys = installKeys({
      focusSearch: () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      toggleLeft: () => {
        panels.value = { ...panels.value, leftOpen: !panels.value.leftOpen };
        savePanels(panels.value);
      },
      toggleRight: () => {
        panels.value = { ...panels.value, rightOpen: !panels.value.rightOpen };
        savePanels(panels.value);
      },
    });
    const offHash = syncHash();
    const url = new URLSearchParams(location.search).get('trace');
    if (url) {
      onNextReady(restoreHash);
      void loadUrl(url);
    } else markReady();
    return () => {
      offInputs();
      offKeys();
      offHash();
    };
  }, []);

  const phase = load.value.phase;
  return (
    <div class={'app phase-' + phase}>
      <TopBar searchRef={searchRef} />
      {phase === 'ready' ? <Workspace panels={panels} /> : phase === 'loading' ? <Loading /> : phase === 'error' ? <Failed /> : <Empty />}
      <Help />
      {dragging.value && (
        <div class="drop-overlay" aria-hidden="true">
          <div>Drop to open — nothing is uploaded</div>
        </div>
      )}
    </div>
  );
}
