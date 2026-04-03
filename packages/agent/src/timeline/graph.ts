import type { TimelineNode } from "../types";

export function isAncestorNode(
  nodes: TimelineNode[],
  ancestorNodeId: string,
  descendantNodeId: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  let cursor = byId.get(descendantNodeId);
  while (cursor) {
    if (cursor.nodeId === ancestorNodeId) return true;
    if (!cursor.parentNodeId) return false;
    cursor = byId.get(cursor.parentNodeId);
  }
  return false;
}
