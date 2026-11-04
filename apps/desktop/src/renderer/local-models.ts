import { useEffect, useSyncExternalStore } from "react";
import type { LocalConnectionInput, LocalConnectionView } from "../shared/local-connections";
import { bridge } from "./bridge";
import { createLocalModelStore, type LocalModelsState } from "./local-model-store";
export * from "./local-model-store";

const store = createLocalModelStore(request => bridge.invoke("local-models:command", request));
export const loadConnections = () => store.loadConnections();
export const discover = (connection: { id: string; revision: number }) => store.discover(connection);
export const cancelDiscovery = (connection: { id: string; revision: number }) => store.cancelDiscovery(connection);
export const discoverAll = (maxAgeMs = 0) => store.discoverAll(maxAgeMs);
export const addConnection = (input: LocalConnectionInput) => store.addConnection(input);
export const updateConnection = (connection: LocalConnectionView, patch: Partial<LocalConnectionInput>) => store.updateConnection(connection, patch);
export const removeConnection = (connection: LocalConnectionView) => store.removeConnection(connection);
export const resetLocalModels = () => store.reset();

export function useLocalModels(): LocalModelsState {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => { if (!store.getState().loaded && bridge.platform !== "web") void store.loadConnections(); }, []);
  return snapshot;
}
