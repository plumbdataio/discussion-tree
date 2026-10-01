// Turn a raw Claude API model id into a short display name for the model chip.
//
//   claude-opus-5-5            -> Opus 5.5
//   claude-sonnet-5            -> Sonnet 5
//   claude-haiku-4-5-20251001  -> Haiku 4.5
//   claude-fable-5-1           -> Fable 5.1
//   claude-3-5-sonnet-20241022 -> Sonnet 3.5   (legacy version-first ids)
//   us.anthropic.claude-opus-4-1-20250805-v1:0 -> Opus 4.1   (Bedrock)
//   claude-opus-4-1@20250805   -> Opus 4.1   (Vertex)
//
// Anything that does not look like a Claude model id is returned unchanged, so a
// new or third-party naming scheme still shows something truthful.

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Version parts are 1-2 digit numbers; an 8-digit chunk is a release date.
function isVersionPart(p: string): boolean {
  return /^\d{1,2}$/.test(p);
}

export function friendlyModelName(raw: string): string {
  if (typeof raw !== "string") return String(raw);
  let id = raw.trim();
  if (!id) return raw;
  // Bedrock: optional region prefix + "anthropic." and a "-vN:M" suffix.
  id = id.replace(/^(?:[a-z]{2,}\.)?anthropic\./, "");
  id = id.replace(/-v\d+(?::\d+)?$/, "");
  // Vertex: "@<date>" suffix. Also drop a "[1m]"-style context suffix.
  id = id.replace(/@.*$/, "").replace(/\[[^\]]*\]$/, "");
  const m = /^claude-(.+)$/.exec(id);
  if (!m) return raw;
  const parts = m[1].split("-").filter((p) => !/^\d{8}$/.test(p));
  if (parts.length === 0) return raw;

  // New style: family first, then version parts (claude-opus-5-5).
  if (/^[a-z]+$/.test(parts[0])) {
    const family = parts[0];
    const ver = parts.slice(1);
    if (ver.length === 0 || ver.length > 2 || !ver.every(isVersionPart)) {
      return raw;
    }
    return `${titleCase(family)} ${ver.join(".")}`;
  }
  // Legacy style: version parts first, then family (claude-3-5-sonnet).
  const famIdx = parts.findIndex((p) => /^[a-z]+$/.test(p));
  if (famIdx <= 0 || famIdx !== parts.length - 1) return raw;
  const ver = parts.slice(0, famIdx);
  if (ver.length > 2 || !ver.every(isVersionPart)) return raw;
  return `${titleCase(parts[famIdx])} ${ver.join(".")}`;
}
