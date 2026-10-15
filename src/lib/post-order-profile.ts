import {CallTreeNode, Frame, FrameInfo, Profile} from './profile'

// For reconstructed timelines whose self work comes after their children.
// Finalize each occurrence once, instead of updating every ancestor for every
// cost. The ordinary event builder also supports self work between children.
export class PostOrderCallTreeProfileBuilder extends Profile {
  private appendStack: CallTreeNode[] = [this.appendOrderCalltreeRoot]
  private groupedStack: CallTreeNode[] = [this.groupedCalltreeRoot]
  private frameCache = new Map<string | number, Frame>()
  private framesInStack = new Map<Frame, number>()
  private groupedChildren = new WeakMap<CallTreeNode, Map<Frame, CallTreeNode>>()

  enterFrame(info: FrameInfo) {
    let frame = this.frameCache.get(info.key)
    if (frame === undefined) {
      frame = Frame.getOrInsert(this.frames, info)
      this.frameCache.set(info.key, frame)
    }
    const parent = this.appendStack[this.appendStack.length - 1]
    const node = new CallTreeNode(frame, parent)
    node.setStartValue(this.totalWeight)
    parent.children.push(node)
    this.appendStack.push(node)
    frame.addToCallCount(1)
    this.framesInStack.set(frame, (this.framesInStack.get(frame) || 0) + 1)
    this.maxStackDepth = Math.max(this.maxStackDepth, this.appendStack.length - 1)

    const groupedParent = this.groupedStack[this.groupedStack.length - 1]
    let children = this.groupedChildren.get(groupedParent)
    if (children === undefined) {
      children = new Map()
      this.groupedChildren.set(groupedParent, children)
    }
    let grouped = children.get(frame)
    if (grouped === undefined) {
      grouped = new CallTreeNode(frame, groupedParent)
      children.set(frame, grouped)
      groupedParent.children.push(grouped)
    }
    this.groupedStack.push(grouped)
  }

  leaveFrame(value: number) {
    if (this.appendStack.length === 1) throw new Error('Trying to leave an empty stack')
    const self = value - this.totalWeight
    if (self < 0)
      throw new Error('Samples must be provided in increasing order of cumulative value')
    const node = this.appendStack.pop()!
    const grouped = this.groupedStack.pop()!
    const total = value - node.getStartValue()!
    node.addToSelfWeight(self)
    node.addToTotalWeight(total)
    node.freeze()
    grouped.addToSelfWeight(self)
    grouped.addToTotalWeight(total)
    node.frame.addToSelfWeight(self)
    const count = this.framesInStack.get(node.frame)!
    if (count === 1) {
      node.frame.addToTotalWeight(total)
      this.framesInStack.delete(node.frame)
    } else {
      this.framesInStack.set(node.frame, count - 1)
    }
    if (self > 0) {
      this.samples.push(node)
      this.weights.push(self)
    }
    this.totalWeight = value
  }

  build(): Profile {
    if (this.appendStack.length !== 1) {
      throw new Error('Tried to complete profile construction with a non-empty stack')
    }
    for (const root of [this.appendOrderCalltreeRoot, this.groupedCalltreeRoot]) {
      root.addToTotalWeight(this.totalWeight - root.getTotalWeight())
    }
    this.sortGroupedCallTree()
    this.groupedChildren = new WeakMap()
    return this
  }
}
