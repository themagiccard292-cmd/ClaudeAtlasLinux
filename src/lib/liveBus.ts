import type { AtlasEvent } from '../../shared/ipc';

export type FrameEvent = Extract<AtlasEvent, { type: 'live:frame' }>;
export type FxEvent = Extract<AtlasEvent, { type: 'live:fx' }>;

/**
 * Video frames arrive ~15×/s. Routing them through React state would re-render the whole app, so they
 * go through this tiny pub/sub straight to the <canvas> that draws them.
 */
const frameSubs = new Set<(e: FrameEvent) => void>();
const fxSubs = new Set<(e: FxEvent) => void>();

export const liveBus = {
  onFrame(cb: (e: FrameEvent) => void): () => void {
    frameSubs.add(cb);
    return () => frameSubs.delete(cb);
  },
  onFx(cb: (e: FxEvent) => void): () => void {
    fxSubs.add(cb);
    return () => fxSubs.delete(cb);
  },
  emitFrame(e: FrameEvent): void {
    frameSubs.forEach((cb) => cb(e));
  },
  emitFx(e: FxEvent): void {
    fxSubs.forEach((cb) => cb(e));
  },
};
