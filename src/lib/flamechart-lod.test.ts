import {
  forEachCallWithLOD,
  FlamechartLODParams,
  getFlamechartLODParams,
  getOverviewFlamechartLODParams,
} from './flamechart-lod'
import {Rect, Vec2} from './math'

test('getOverviewFlamechartLODParams covers the full profile at ~1px resolution', () => {
  const params = getOverviewFlamechartLODParams(4000)
  expect(params.minFrameWidth).toBe(1)
  expect(params.viewLeft).toBe(0)
  expect(params.viewRight).toBe(4000)
})

test('getFlamechartLODParams quantizes viewport and expands the visible range', () => {
  const total = 1024
  const params = getFlamechartLODParams(total, new Rect(new Vec2(100, 0), new Vec2(200, 10)))
  expect(params.quantizedViewportWidth).toBe(256)
  expect(params.minFrameWidth).toBe(256 / 4000)
  expect(params.viewLeft).toBe(0)
  expect(params.viewRight).toBe(556)
})

function makeRoot() {
  return {
    frame: {key: 'root', name: 'root'},
    parent: null,
    children: [] as any[],
    isRoot: () => true,
    getTotalWeight: () => 100,
  }
}

function makeNode(name: string, total: number, parent: any) {
  const node = {
    frame: {key: name, name},
    parent,
    children: [] as any[],
    getTotalWeight: () => total,
    isRoot: () => false,
  }
  parent.children.push(node)
  return node
}

test('forEachCallWithLOD skips subtrees thinner than the LOD threshold', () => {
  const realRoot = makeRoot()
  const big = makeNode('big', 90, realRoot)
  makeNode('tiny', 5, big)
  makeNode('alsoTiny', 5, realRoot)

  const opened: string[] = []
  const params: FlamechartLODParams = {
    minFrameWidth: 10,
    viewLeft: 0,
    viewRight: 100,
    quantizedViewportWidth: 100,
  }

  forEachCallWithLOD(
    realRoot as any,
    params,
    node => opened.push(`open:${node.frame.name}`),
    node => opened.push(`close:${node.frame.name}`),
  )

  expect(opened).toEqual(['open:big', 'close:big'])
})

test('forEachCallWithLOD skips subtrees outside the visible range', () => {
  const realRoot = makeRoot()
  makeNode('left', 40, realRoot)
  makeNode('middle', 20, realRoot)
  makeNode('right', 40, realRoot)

  const opened: string[] = []
  forEachCallWithLOD(
    realRoot as any,
    {minFrameWidth: 1, viewLeft: 40, viewRight: 60, quantizedViewportWidth: 20},
    node => opened.push(node.frame.name),
    () => {},
  )

  expect(opened).toEqual(['middle'])
})
