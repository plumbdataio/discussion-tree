import React, { useEffect, useState } from "react";

// Global toast queue. A separate module-level array + listener set
// rather than React context so any non-component caller (e.g. the
// favorites store on success/failure) can fire one without prop
// drilling. Toasts auto-dismiss after TOAST_TTL_MS.
const TOAST_TTL_MS = 3000;

export type ToastTone = "ok" | "error";

type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

const toasts: Toast[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function notify() {
  for (const l of listeners) l();
}

export function showToast(message: string, tone: ToastTone = "ok"): void {
  const id = nextId++;
  toasts.push({ id, message, tone });
  notify();
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) {
      toasts.splice(i, 1);
      notify();
    }
  }, TOAST_TTL_MS);
}

// Single mount point in frontend.tsx. Positions itself top-right via
// CSS (.toast-container is position: fixed).
export function ToastContainer() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((v) => v + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role="status">
          {t.message}
        </div>
      ))}
    </div>
  );
}
