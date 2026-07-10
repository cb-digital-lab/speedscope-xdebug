import {CallTreeNode} from './profile'
import {SortDirection, TreeSortField, TreeSortMethod} from '../app-state'

export interface CallTreeRow {
  node: CallTreeNode
  depth: number
  hasChildren: boolean
  isExpanded: boolean
}

function sortChildren(children: CallTreeNode[], sortMethod: TreeSortMethod): CallTreeNode[] {
  if (sortMethod.field === TreeSortField.CALL_ORDER) {
    return children
  }

  const sorted = [...children]
  if (sortMethod.field === TreeSortField.TOTAL) {
    sorted.sort((a, b) => a.getTotalWeight() - b.getTotalWeight())
  } else {
    sorted.sort((a, b) => a.getSelfWeight() - b.getSelfWeight())
  }

  if (sortMethod.direction === SortDirection.DESCENDING) {
    sorted.reverse()
  }

  return sorted
}

export function buildCallTreeRows(
  root: CallTreeNode,
  expandedNodes: Set<CallTreeNode>,
  sortMethod: TreeSortMethod,
): CallTreeRow[] {
  const rows: CallTreeRow[] = []

  function visit(node: CallTreeNode, depth: number) {
    const hasChildren = node.children.length > 0
    const isExpanded = expandedNodes.has(node)

    rows.push({node, depth, hasChildren, isExpanded})

    if (hasChildren && isExpanded) {
      for (let child of sortChildren(node.children, sortMethod)) {
        visit(child, depth + 1)
      }
    }
  }

  for (let child of sortChildren(root.children, sortMethod)) {
    visit(child, 0)
  }

  return rows
}

export function getAllExpandableNodes(root: CallTreeNode): Set<CallTreeNode> {
  const expandable = new Set<CallTreeNode>()

  function visit(node: CallTreeNode) {
    if (node.children.length > 0) {
      expandable.add(node)
      for (let child of node.children) {
        visit(child)
      }
    }
  }

  for (let child of root.children) {
    visit(child)
  }

  return expandable
}

export function getAncestorNodes(node: CallTreeNode): CallTreeNode[] {
  const ancestors: CallTreeNode[] = []
  for (let current = node.parent; current != null && !current.isRoot(); current = current.parent) {
    ancestors.push(current)
  }
  return ancestors
}
