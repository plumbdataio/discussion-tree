import type { Node } from "../../shared/types.ts";

export function buildTree(nodes: Node[]) {
  const byParent = new Map<string | null, Node[]>();
  for (const n of nodes) {
    const key = n.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(n);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position);
  }
  return byParent;
}
