import {CallTreeNode} from './profile'
import {SortDirection, TreeSortField, TreeSortMethod} from '../app-state'

export interface CallTreeRow {
  node: CallTreeNode
  depth: number
  hasChildren: boolean
  isExpanded: boolean

  // Heat ratios in [0, 1] relative to the heaviest sibling in the same scope
  // (nodes sharing the same parent). The worst offender in each scope is 1.
  totalHeat: number
  selfHeat: number
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

  function visitScope(siblings: CallTreeNode[], depth: number) {
    let maxTotal = 0
    let maxSelf = 0
    for (let sibling of siblings) {
      const total = sibling.getTotalWeight()
      const self = sibling.getSelfWeight()
      if (total > maxTotal) maxTotal = total
      if (self > maxSelf) maxSelf = self
    }

    for (let node of sortChildren(siblings, sortMethod)) {
      const hasChildren = node.children.length > 0
      const isExpanded = expandedNodes.has(node)

      rows.push({
        node,
        depth,
        hasChildren,
        isExpanded,
        totalHeat: maxTotal > 0 ? node.getTotalWeight() / maxTotal : 0,
        selfHeat: maxSelf > 0 ? node.getSelfWeight() / maxSelf : 0,
      })

      if (hasChildren && isExpanded) {
        visitScope(node.children, depth + 1)
      }
    }
  }

  visitScope(root.children, 0)

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
