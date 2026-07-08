// Promise-based gate for "the recipient session has a pending timer send — send
// this live message now?". A composer calls confirmBeforeSend() right before
// actually sending; if the session isn't armed it resolves true immediately, so
// the common path is free. If armed, it hands a request to the single global
// TimerConfirmModal and resolves to the user's choice.
export type TimerConfirmRequest = {
  sessionId: string;
  count: number;
  resolve: (proceed: boolean) => void;
};

let pending: TimerConfirmRequest | null = null;
const listeners = new Set<() => void>();

export function confirmBeforeSend(
  armed: boolean,
  sessionId: string,
  count: number,
): Promise<boolean> {
  if (!armed) return Promise.resolve(true);
  // If a confirm is somehow already open, don't stack — just proceed.
  if (pending) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    pending = { sessionId, count, resolve };
    for (const l of listeners) l();
  });
}

export function getPendingConfirm(): TimerConfirmRequest | null {
  return pending;
}

export function clearPendingConfirm() {
  pending = null;
}

export function subscribeConfirm(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
