import {CallTreeNode} from './profile'
import {Rect} from './math'

export const FLAMECHART_LOD_PIXELS = 4000

export interface FlamechartLODParams {
  minFrameWidth: number
  viewLeft: number
  viewRight: number
  quantizedViewportWidth: number
}

export function getFlamechartLODParams(
  totalWeight: number,
  configSpaceViewportRect: Rect,
): FlamechartLODParams {
  const rawViewportWidth =
    configSpaceViewportRect.isEmpty() || configSpaceViewportRect.width() <= 0
      ? totalWeight
      : configSpaceViewportRect.width()

  const quantizedViewportWidth = quantizeViewportWidth(totalWeight, rawViewportWidth)
  const minFrameWidth = quantizedViewportWidth / FLAMECHART_LOD_PIXELS

  let viewLeft = 0
  let viewRight = totalWeight
  if (!configSpaceViewportRect.isEmpty() && configSpaceViewportRect.width() > 0) {
    const margin = quantizedViewportWidth
    viewLeft = Math.max(0, configSpaceViewportRect.left() - margin)
    viewRight = Math.min(totalWeight, configSpaceViewportRect.right() + margin)
  }

  return {minFrameWidth, viewLeft, viewRight, quantizedViewportWidth}
}

export function getOverviewFlamechartLODParams(totalWeight: number): FlamechartLODParams {
  return {
    minFrameWidth: totalWeight / FLAMECHART_LOD_PIXELS,
    viewLeft: 0,
    viewRight: totalWeight,
    quantizedViewportWidth: totalWeight,
  }
}

function quantizeViewportWidth(totalWeight: number, viewportWidth: number): number {
  if (!(totalWeight > 0)) return 0
  const ratio = Math.min(1, Math.max(viewportWidth / totalWeight, 1 / 1024))
  const bucket = Math.pow(2, Math.ceil(Math.log2(ratio)))
  return totalWeight * bucket
}

export function forEachCallWithLOD(
  root: CallTreeNode,
  params: FlamechartLODParams,
  openFrame: (node: CallTreeNode, value: number) => void,
  closeFrame: (node: CallTreeNode, value: number) => void,
) {
  const {minFrameWidth, viewLeft, viewRight} = params

  function visit(node: CallTreeNode, start: number): number {
    if (node.isRoot()) {
      let t = start
      for (const child of node.children) {
        t = visit(child, t)
      }
      return t
    }

    const total = node.getTotalWeight()
    if (total < minFrameWidth) {
      return start + total
    }
    if (start + total <= viewLeft || start >= viewRight) {
      return start + total
    }

    openFrame(node, start)
    let t = start
    for (const child of node.children) {
      t = visit(child, t)
    }
    closeFrame(node, start + total)
    return start + total
  }

  visit(root, 0)
}
