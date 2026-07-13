import {CallTreeNode, Profile} from './profile'
import {CallTreeRow} from './call-tree-rows'
import {formatPercent} from './utils'

function frameLocation(node: CallTreeNode): string {
  const {frame} = node
  if (!frame.file) return ''
  let pos = frame.file
  if (frame.line != null) {
    pos += `:${frame.line}`
  }
  return pos
}

function formatTimings(profile: Profile, node: CallTreeNode): string {
  const grandTotal = profile.getTotalNonIdleWeight()
  const total = node.getTotalWeight()
  const self = node.getSelfWeight()
  const totalPerc = grandTotal > 0 ? (100.0 * total) / grandTotal : 0
  const selfPerc = grandTotal > 0 ? (100.0 * self) / grandTotal : 0
  return (
    `total ${profile.formatValue(total)} (${formatPercent(totalPerc)}), ` +
    `self ${profile.formatValue(self)} (${formatPercent(selfPerc)})`
  )
}

// Builds a self-contained prompt describing a hot path in a WordPress/Xdebug
// profile, meant to be pasted into an AI chat for performance analysis.
export function buildAnalysisPrompt(
  profile: Profile,
  selectedNode: CallTreeNode,
  calleeRows: CallTreeRow[],
  selectedDepth: number,
): string {
  const lines: string[] = []

  lines.push('# WordPress performance analysis request')
  lines.push('')
  lines.push(
    'I am profiling a WordPress application with Xdebug (cachegrind), viewed as a call ' +
      'tree in speedscope. Below is a hot path I want you to analyze.',
  )
  lines.push('')
  lines.push('## Constraints (important)')
  lines.push(
    '- I CANNOT modify WordPress core, plugin, or theme third-party source code. Assume all ' +
      'of it is off-limits to edit.',
  )
  lines.push(
    '- Only propose fixes I can apply from user-land: configuration changes, plugin/theme ' +
      'settings, enabling/disabling features, caching, server/PHP configuration, or WordPress ' +
      'hooks (filters/actions) that I add in my own code (e.g. an mu-plugin or a small custom plugin).',
  )
  lines.push(
    '- If the root cause lives inside third-party code, explain what is happening and propose a ' +
      'user-land mitigation, configuration change, or a hook-based workaround instead of a code edit.',
  )
  lines.push(
    '- Look for misconfiguration, redundant/repeated work, N+1 patterns, missing caching, or ' +
      'otherwise suspicious behavior visible in the timings below.',
  )
  lines.push('')

  lines.push('## Selected function')
  const loc = frameLocation(selectedNode)
  lines.push(`\`${selectedNode.frame.name}\`${loc ? ` (${loc})` : ''}`)
  lines.push(`- ${formatTimings(profile, selectedNode)}`)
  lines.push('')

  lines.push('## Call stack (root down to the selected function)')
  lines.push('```')
  const stack: CallTreeNode[] = []
  for (let n: CallTreeNode | null = selectedNode; n != null && !n.isRoot(); n = n.parent) {
    stack.push(n)
  }
  stack.reverse()
  stack.forEach((node, i) => {
    const indent = '  '.repeat(i)
    const nodeLoc = frameLocation(node)
    lines.push(
      `${indent}${node.frame.name}${nodeLoc ? ` [${nodeLoc}]` : ''} — ${formatTimings(
        profile,
        node,
      )}`,
    )
  })
  lines.push('```')
  lines.push('')

  lines.push('## Expanded callees below the selected function')
  lines.push('(Only the branches I expanded are included. Indentation shows the call hierarchy.)')
  lines.push('```')
  lines.push(`${selectedNode.frame.name} — ${formatTimings(profile, selectedNode)}`)
  if (calleeRows.length === 0) {
    lines.push('  (no expanded callees)')
  } else {
    for (let row of calleeRows) {
      const indent = '  '.repeat(row.depth - selectedDepth)
      lines.push(`${indent}${row.node.frame.name} — ${formatTimings(profile, row.node)}`)
    }
  }
  lines.push('```')
  lines.push('')

  lines.push('## Task')
  lines.push(
    '1. Identify the most likely performance bottleneck(s) in this path, using the timings and ' +
      'the call structure as evidence.',
  )
  lines.push('2. Explain concretely why each bottleneck is slow.')
  lines.push(
    '3. Propose specific user-land fixes (configuration, settings, caching, or filters/actions ' +
      'I can add), respecting the constraints above. For each fix, note the expected impact and any risk.',
  )

  return lines.join('\n')
}
