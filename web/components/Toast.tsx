import React, { useEffect, useState } from "react";

// Global toast queue. A separate module-level array + listener set
// rather than React context so any non-component caller (e.g. the
// favorites store on success/failure) can fire one without prop
// drilling. Toasts auto-dismiss after TOAST_TTL_MS.
const TOAST_TTL_MS = 3000;

export type ToastTone = "ok" | "error";

// An optional inline button (e.g. "Undo" after a delete). Clicking it runs
// onClick and dismisses the toast.
export type ToastAction = { label: string; onClick: () => void };

type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
};

const toasts: Toast[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function notify() {
  for (const l of listeners) l();
}

function dismiss(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) {
    toasts.splice(i, 1);
    notify();
  }
}

// A toast with an action button lingers longer so the user can reach for it.
const TOAST_TTL_ACTION_MS = 6000;

export function showToast(
  message: string,
  tone: ToastTone = "ok",
  action?: ToastAction,
): void {
  const id = nextId++;
  toasts.push({ id, message, tone, action });
  notify();
  setTimeout(() => dismiss(id), action ? TOAST_TTL_ACTION_MS : TOAST_TTL_MS);
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
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
