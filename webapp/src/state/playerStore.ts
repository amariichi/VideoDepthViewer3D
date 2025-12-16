import { createStore } from 'zustand/vanilla';
import type { SessionInfo, ViewerControls, PerfSettings } from '../types';
import type { DepthClient } from '../network/depthClient'; // 追加（type import）

export interface PlayerState {
  video: HTMLVideoElement | null;
  session: SessionInfo | null;
  viewerControls: ViewerControls;
  perfSettings: PerfSettings;
  depthConnected: boolean;
  depthClient: DepthClient | null;
  setVideo: (video: HTMLVideoElement) => void;
  setSession: (session: SessionInfo | null) => void;
  setDepthConnected: (connected: boolean) => void;
  setDepthClient: (client: DepthClient | null) => void;
  updateControls: (patch: Partial<ViewerControls>) => void;
  updatePerfSettings: (patch: Partial<PerfSettings>) => void;
}

const defaultControls: ViewerControls = {
  targetTriangles: 200_000,
  fovY: 50,
  zScale: 1.0,
  zBias: 0.0,
  zGamma: 1.0,
  zMaxClip: 50,
  planeScale: 2.0,
  yOffset: 1.2,
};

const getUrlParam = (key: string): number | null => {
  const params = new URLSearchParams(window.location.search);
  const val = params.get(key);
  return val ? Number(val) : null;
};

const defaultPerfSettings: PerfSettings = {
  depthLeadMs: 2000,
  maxInflightRequests: getUrlParam('maxInflight') || 8,
  autoLead: false,
};

import { DepthSyncController } from '../network/depthSyncController';

const store = createStore<PlayerState>((set, get) => {
  // Initialize controller with access to store methods
  const depthSyncController = new DepthSyncController(
    () => get(),
    (patch) => set((state) => ({ perfSettings: { ...state.perfSettings, ...patch } }))
  );

  return {
    video: null,
    session: null,
    viewerControls: defaultControls,
    perfSettings: defaultPerfSettings,
    depthConnected: false,
    depthClient: null,
    // We don't expose depthSyncController in the interface if not needed, 
    // but we need to keep it alive. 
    // Actually, let's attach it to the store instance or closure.
    // But we need to call it in setSession.
    // Let's add it to the state but maybe not the interface if we want to hide it?
    // Or just add it to the interface.

    setVideo: (video) => set({ video }),
    setSession: (session) => {
      if (session) {
        depthSyncController.start(session.sessionId);
      } else {
        depthSyncController.stop();
      }
      set({ session });
    },
    setDepthConnected: (depthConnected) => set({ depthConnected }),
    setDepthClient: (depthClient) => set({ depthClient }),
    updateControls: (patch) =>
      set((state) => ({
        viewerControls: { ...state.viewerControls, ...patch },
      })),
    updatePerfSettings: (patch) =>
      set((state) => ({
        perfSettings: { ...state.perfSettings, ...patch },
      })),
  };
});

export const usePlayerStore = {
  getState: () => store.getState(),
  setState: store.setState,
  subscribe: store.subscribe,
};
