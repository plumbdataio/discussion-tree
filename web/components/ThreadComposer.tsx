import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { TimerSendButton } from "./TimerSendButton.tsx";
import { extractImageFiles, uploadImage } from "../utils/api.ts";
import { useDraft } from "../utils/drafts.ts";

// @reusable-ui ThreadComposer — USE WHEN: a chat thread needs its reply box
// (textarea + image paste/drop upload + send / timer-send) under a long list
// of messages. INSTEAD OF: holding the draft state in the component that also
// renders the thread — then every keystroke re-renders that component and
// reconciles the whole message list (thousands of rows on a long board).
// The draft (persisted per board/node by useDraft), upload and submitting
// state all live here, so typing re-renders only this box.
export function ThreadComposer({
  className,
  draftBoardId,
  timerBoardId,
  nodeId,
  ownerAlive,
  placeholder,
  confirmSend,
  onSend,
  onTentative,
  extraActions,
  timerSend = true,
}: {
  // Wrapper class of the input row (layout differs per surface).
  className: string;
  // Board id keying the persisted draft and the image upload directory.
  draftBoardId: string;
  // Board id the timer-send reservation is filed under.
  timerBoardId: string;
  nodeId: string;
  ownerAlive: boolean;
  placeholder: string;
  // Gate before a live send (e.g. confirm while a timer send is armed).
  // Resolve false to cancel; the draft is left untouched.
  confirmSend: () => Promise<boolean>;
  // Delivers the message; must throw on failure so the text is restored.
  onSend: (text: string) => Promise<void>;
  // The in-flight message shown in the thread: the text while sending, null
  // once it succeeded or failed.
  onTentative: (text: string | null) => void;
  // Extra buttons rendered before the upload status / send button.
  extraActions?: React.ReactNode;
  // false renders a plain send button with no timer-send menu (the node
  // preview modal); timerBoardId is then unused.
  timerSend?: boolean;
}) {
  const { t } = useTranslation();
  // Persisted-on-localStorage draft so a refresh / SPA-nav / accidental tab
  // close doesn't lose what the user was typing. Cleared on successful send.
  const [draft, setDraft] = useDraft(draftBoardId, nodeId);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: { url: string; path: string }[] = [];
      for (const f of files) {
        try {
          uploaded.push(await uploadImage(f, draftBoardId));
        } catch (e) {
          alert(
            t("item_card.image_upload_failed", {
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
      if (uploaded.length > 0) {
        setDraft((prev) => {
          const sep = prev && !prev.endsWith("\n") ? "\n" : "";
          // Markdown image syntax (rendered inline via broker's /uploads/ route)
          // + a clickable link that opens the same URL in a new browser tab so
          // the user can see the original at full size. The display text shows
          // the absolute filesystem path so Claude Code can extract it via its
          // Read tool.
          const block = uploaded
            .map((u) => `![image](${u.url})\n[image] [${u.path}](${u.url})`)
            .join("\n\n");
          return prev + sep + block + "\n";
        });
      }
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = extractImageFiles(e.clipboardData?.items ?? null);
    if (files.length > 0) {
      e.preventDefault();
      handleImageFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = extractImageFiles(e.dataTransfer?.files ?? null);
    if (files.length > 0) {
      e.preventDefault();
      handleImageFiles(files);
    }
  };

  const handleSubmit = async () => {
    const text = draft.trim();
    if (!text) return;
    if (!(await confirmSend())) return;
    setSubmitting(true);
    onTentative(text);
    setDraft("");
    try {
      await onSend(text);
      onTentative(null);
    } catch (e) {
      // Restore the text so the user can retry without retyping.
      onTentative(null);
      setDraft(text);
      alert(
        t("item_card.send_failed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  const sendDisabled = submitting || uploading || !draft.trim() || !ownerAlive;

  return (
    <div className={className}>
      <ResizableTextarea
        className="answer-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        onPaste={handlePaste}
        onDrop={handleDrop}
        disabled={!ownerAlive}
        placeholder={placeholder}
      />
      <div className="actions">
        {extraActions}
        {uploading && (
          <span className="upload-status">
            {t("item_card.image_uploading")}
          </span>
        )}
        {timerSend ? (
          <TimerSendButton
            sendLabel={t("item_card.send_button")}
            sendDisabled={sendDisabled}
            onSend={handleSubmit}
            boardId={timerBoardId}
            nodeId={nodeId}
            getText={() => draft}
            onScheduled={() => setDraft("")}
          />
        ) : (
          <button onClick={handleSubmit} disabled={sendDisabled}>
            {t("item_card.send_button")}
          </button>
        )}
      </div>
    </div>
  );
}
