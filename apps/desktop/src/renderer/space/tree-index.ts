import { canContain, type NotesNode, type NotesTree } from "../../shared/notes.js";

/**
 * Lookups over one notes tree, built in a single pass. The tree draws every row on each render, so a row
 * finds its parent and children here instead of scanning all the nodes, which made a render cost the
 * square of the tree's size.
 */
export interface NotesTreeIndex {
  get(id: string): NotesNode | undefined;
  /** In tree order; null gives the workspaces. */
  children(id: string | null): NotesNode[];
  /** Where a node can move, in tree order: any container that may hold it, except its own and anything inside it. */
  targetsFor(node: NotesNode): NotesNode[];
}

export function indexTree(tree: NotesTree): NotesTreeIndex {
  const byId = new Map<string, NotesNode>();
  const byParent = new Map<string | null, NotesNode[]>();
  for (const node of tree.nodes) {
    byId.set(node.id, node);
    const siblings = byParent.get(node.parentId);
    if (siblings) siblings.push(node); else byParent.set(node.parentId, [node]);
  }
  const none: NotesNode[] = [];
  return {
    get: id => byId.get(id),
    children: id => byParent.get(id) ?? none,
    // One pass per call: a menu asks only once it is open, and a drag once when it starts.
    targetsFor: node => tree.nodes.filter(target => canContain(target.kind, node.kind) && target.id !== node.parentId
      && target.rel !== node.rel && !target.rel.startsWith(`${node.rel}/`)),
  };
}
