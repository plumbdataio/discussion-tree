import type { BoardListItem } from "../../shared/types.ts";
import { normalizeBoardStatus } from "./constants.ts";
import type { BoardStatusFilter } from "./settings.ts";

// Whether a board should appear in the sidebar given the user's status
// filter. Two unconditional escape hatches before the filter applies:
//
//   1. The default conversation board — it's the universal inbox; hiding
//      it behind a status filter never makes sense.
//   2. The board currently being viewed — if you open a board by direct
//      URL whose status the filter excludes, the sidebar would otherwise
//      have no entry for the page you're actually on. Always show it.
//
// Only after those does the status filter decide.
export function isBoardVisible(
  board: Pick<BoardListItem, "id" | "status" | "is_default">,
  filter: BoardStatusFilter,
  currentBoardId: string | null,
): boolean {
  if (board.is_default) return true;
  if (currentBoardId != null && board.id === currentBoardId) return true;
  const status = normalizeBoardStatus(board.status) as keyof BoardStatusFilter;
  return filter[status] !== false;
}
