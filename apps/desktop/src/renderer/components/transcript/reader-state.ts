import { createContext, useContext, useState, type Dispatch, type SetStateAction } from 'react';

interface ReaderState {
  expanded: Map<string, boolean | null>;
  scroll?: { top: number; follow: boolean };
}
// Ephemeral view preferences only, scoped to a thread. Never persist transcript text or actions.
// Bound both dimensions so visiting old histories cannot retain unbounded UI state.
const readers = new Map<string, ReaderState>();
export function readerStateFor(threadId: string): ReaderState {
  const state = readers.get(threadId) ?? { expanded: new Map() };
  readers.delete(threadId);
  readers.set(threadId, state);
  if (readers.size > 100) readers.delete(readers.keys().next().value!);
  return state;
}
export const ReaderStateContext = createContext<ReaderState | null>(null);

export function useExpansionState<T extends boolean | null>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const state = useContext(ReaderStateContext);
  const [value, setValue] = useState<T>(() => state?.expanded.has(key) ? state.expanded.get(key) as T : initial);
  const set: Dispatch<SetStateAction<T>> = next => setValue(previous => {
    const value = typeof next === 'function' ? next(previous) : next;
    if (state) {
      state.expanded.delete(key);
      state.expanded.set(key, value);
      if (state.expanded.size > 1000) state.expanded.delete(state.expanded.keys().next().value!);
    }
    return value;
  });
  return [value, set];
}
