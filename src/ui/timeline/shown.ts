// Shared between the timeline and the overview (nothing else reads these).
//
// `shownView` is the view as currently painted: it eases toward state.view over
// 150 ms when the view jumps (keys, a selection elsewhere), so the overview's
// brush follows the animation rather than snapping ahead of it.

import { signal } from '@preact/signals';

export const shownView = signal<{ t0: number; t1: number } | null>(null);

/** Set just before a direct-manipulation view change (wheel, drag) so it is applied without easing. */
export const immediate = { next: false };

export function setViewNow(fn: () => void): void {
  immediate.next = true;
  try {
    fn();
  } finally {
    immediate.next = false;
  }
}
