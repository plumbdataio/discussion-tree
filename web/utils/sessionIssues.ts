// Cross-component channel to open the per-session issue modal from anywhere
// (the sidebar's per-session "issues" entry). One SessionIssuesModal, rendered
// once in frontend.tsx, subscribes; every trigger just dispatches the open
// event with the target session, so triggers don't own the modal state. Same
// pattern as scheduledList.ts.
export type SessionIssuesTarget = {
  sessionId: string;
  sessionName: string | null;
};

const OPEN_EVENT = "pd-open-session-issues";

export function openSessionIssues(target: SessionIssuesTarget) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: target }));
}

export function subscribeOpenSessionIssues(
  cb: (target: SessionIssuesTarget) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb((e as CustomEvent).detail as SessionIssuesTarget);
  window.addEventListener(OPEN_EVENT, h);
  return () => window.removeEventListener(OPEN_EVENT, h);
}
