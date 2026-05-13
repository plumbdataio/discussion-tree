export function postSubmitAnswer(
  boardId: string,
  nodeId: string,
  text: string,
) {
  return fetch("/submit-answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: boardId, node_id: nodeId, text }),
  });
}

export async function uploadImage(
  file: File,
  boardId: string,
): Promise<{ url: string; path: string }> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const res = await fetch("/upload-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board_id: boardId,
      filename: file.name || "pasted",
      mime: file.type,
      data_base64: data,
    }),
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    ok: boolean;
    path?: string;
    url?: string;
    error?: string;
  };
  if (!json.ok || !json.path || !json.url) {
    throw new Error(json.error ?? "upload failed");
  }
  return { url: json.url, path: json.path };
}

export function extractImageFiles(
  items: DataTransferItemList | FileList | null,
): File[] {
  if (!items) return [];
  const result: File[] = [];
  if (items instanceof FileList) {
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f && f.type.startsWith("image/")) result.push(f);
    }
    return result;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "file") {
      const f = it.getAsFile();
      if (f && f.type.startsWith("image/")) result.push(f);
    }
  }
  return result;
}
