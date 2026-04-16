import { useCallback, useEffect, useRef, useState } from "react";

export type HistoryApi<T> = {
  state: T;
  set: (next: T | ((prev: T) => T), options?: { coalesce?: string }) => void;
  reset: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export const useHistory = <T>(initial: T): HistoryApi<T> => {
  const [past, setPast] = useState<T[]>([]);
  const [present, setPresent] = useState<T>(initial);
  const [future, setFuture] = useState<T[]>([]);
  const lastCoalesceKey = useRef<string | null>(null);

  const set = useCallback(
    (next: T | ((prev: T) => T), options?: { coalesce?: string }) => {
      setPresent((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (Object.is(resolved, prev)) return prev;
        const coalesce = options?.coalesce ?? null;
        if (coalesce && lastCoalesceKey.current === coalesce) {
          // keep past unchanged — treat as continuation of last edit
        } else {
          setPast((p) => [...p, prev]);
        }
        lastCoalesceKey.current = coalesce;
        setFuture([]);
        return resolved;
      });
    },
    [],
  );

  const reset = useCallback((next: T) => {
    setPast([]);
    setFuture([]);
    lastCoalesceKey.current = null;
    setPresent(next);
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [present, ...f]);
      setPresent(prev);
      lastCoalesceKey.current = null;
      return p.slice(0, -1);
    });
  }, [present]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, present]);
      setPresent(next);
      lastCoalesceKey.current = null;
      return f.slice(1);
    });
  }, [present]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  return {
    state: present,
    set,
    reset,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  };
};
