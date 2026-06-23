import React, { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { useTranslation } from "react-i18next";
import { Sidebar } from "./Sidebar.tsx";

// Read-only Mermaid diagram surface (a 3rd surface alongside boards & maps).
// The source is owned by CC via the upsert_diagram MCP tool; this page renders
// it and live-re-renders on the diagram's WS channel whenever CC upserts.
export function DiagramView({ diagramId }: { diagramId: string }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const renderSeq = useRef(0);

  const fetchDiagram = () => {
    fetch(`/api/diagram/${diagramId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        setTitle(j.diagram?.title ?? "");
        setSource(j.diagram?.source ?? "");
        setNotFound(false);
      })
      .catch(() => setNotFound(true));
  };

  useEffect(fetchDiagram, [diagramId]);

  // Live update: the broker broadcasts on the diagram's id channel.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${diagramId}`);
    const onMsg = (e: MessageEvent) => {
      try {
        const m = JSON.parse(e.data);
        if (m?.type === "diagram-update") fetchDiagram();
        else if (m?.type === "diagram-deleted") setNotFound(true);
      } catch {
        /* ignore */
      }
    };
    ws.addEventListener("message", onMsg);
    return () => {
      ws.removeEventListener("message", onMsg);
      try {
        ws.close();
      } catch {
        /* race with teardown */
      }
    };
  }, [diagramId]);

  // Render the Mermaid source to SVG whenever it changes. The render is async
  // and the source can change again mid-flight (a fresh upsert), so a sequence
  // guard drops stale results. Parse failures surface as an inline error.
  useEffect(() => {
    if (source == null) return;
    const seq = ++renderSeq.current;
    const dark = document.documentElement.dataset.theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
    });
    mermaid
      .render(`dg-render-${seq}`, source)
      .then(({ svg }) => {
        if (seq !== renderSeq.current) return;
        setSvg(svg);
        setError(null);
      })
      .catch((e) => {
        if (seq !== renderSeq.current) return;
        setError(String(e?.message ?? e));
        setSvg("");
      });
  }, [source]);

  return (
    <div className="app-body">
      <Sidebar currentBoardId={null} />
      <div className="diagram-container">
        <header className="diagram-header">
          <a className="diagram-back" href="/">
            {t("diagram.home")}
          </a>
          <h1 className="diagram-title">{title || t("diagram.untitled")}</h1>
        </header>
        {notFound ? (
          <div className="diagram-message">{t("diagram.not_found")}</div>
        ) : error ? (
          <div className="diagram-error">
            <strong>{t("diagram.parse_error")}</strong>
            <pre>{error}</pre>
          </div>
        ) : (
          <div
            className="diagram-canvas"
            // mermaid sanitizes with securityLevel:strict; the SVG is its output.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </div>
  );
}
