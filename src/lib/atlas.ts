import type { AtlasApi } from '../../shared/ipc';

declare global {
  interface Window {
    atlas?: AtlasApi;
  }
}

/** The preload-exposed API. Throws early with a clear message if opened outside Electron. */
export function atlas(): AtlasApi {
  if (!window.atlas) throw new Error('window.atlas is missing — open this page inside Claude OS Agent.');
  return window.atlas;
}

export const isHudRoute = (): boolean => window.location.hash.startsWith('#/hud');

export async function ensureApi(): Promise<void> {
  if (window.atlas) return;
  const { installMock } = await import('./mock');
  installMock();
}
