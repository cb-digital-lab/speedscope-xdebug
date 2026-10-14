import {McpServer} from '@modelcontextprotocol/server'
import {z} from 'zod'
import {ProfileRepository} from './profile-analysis'

export function createSpeedscopeServer(directory: string) {
  const repository = new ProfileRepository(directory)
  const server = new McpServer(
    {name: 'speedscope-xdebug', version: '0.1.0'},
    {
      instructions:
        'Analyze local WordPress Xdebug profiles. Start with list_profiles and load_profile, then reuse the returned datasetId. Costs include profiling overhead; reconstructedStart is not a recorded timestamp. Caller totals are costs of the selected function under that caller. Use node paths to drill down. Do not infer SQL arguments, hook names or cache hits that are absent from the data. Suggest configuration, caching or custom hooks rather than edits to third-party code.',
    },
  )
  const scope = {datasetId: z.string(), profileIndex: z.number().int().min(0).default(0)}
  const paging = {
    offset: z.number().int().min(0).max(1000).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  }
  const sorting = {sort: z.enum(['total', 'self', 'count']).default('total')}
  const nodePath = z.array(z.number().int().min(0)).max(1000).default([])
  const functionKey = z.union([z.string(), z.number()])
  const annotations = {readOnlyHint: true, destructiveHint: false, openWorldHint: false}
  const result = async (work: () => unknown | Promise<unknown>) => {
    try {
      const data = await work()
      return {content: [{type: 'text' as const, text: JSON.stringify(data)}]}
    } catch (error) {
      return {
        isError: true,
        content: [
          {type: 'text' as const, text: error instanceof Error ? error.message : String(error)},
        ],
      }
    }
  }
  server.registerTool(
    'list_profiles',
    {description: 'List files in the configured local profiles directory.', annotations},
    () => result(() => repository.list()),
  )
  server.registerTool(
    'load_profile',
    {
      description:
        'Load one Xdebug file from the profiles directory. Replaces the active dataset and returns metric indices and a new datasetId.',
      inputSchema: z.object({filename: z.string()}),
      annotations: {...annotations, readOnlyHint: false},
    },
    ({filename}) => result(() => repository.load(filename)),
  )
  server.registerTool(
    'profile_summary',
    {description: 'Get the active dataset ID and available time/memory metrics.', annotations},
    () => result(() => repository.summary()),
  )
  server.registerTool(
    'find_functions',
    {
      description:
        'Search function names and file paths, ordered by inclusive cost, self cost or occurrences. Raw costs use the metric unit from the summary.',
      inputSchema: z.object({...scope, ...paging, ...sorting, query: z.string().default('')}),
      annotations,
    },
    args =>
      result(() =>
        repository
          .get(args.datasetId, args.profileIndex)
          .functions(args.query, args.sort, args.offset, args.limit),
      ),
  )
  server.registerTool(
    'call_tree',
    {
      description:
        'Get a bounded page of children of a call-tree node. Empty path means the synthetic root; returned paths preserve original child indices regardless of sorting.',
      inputSchema: z.object({
        ...scope,
        ...paging,
        sort: z.enum(['total', 'self']).default('total'),
        path: nodePath,
      }),
      annotations,
    },
    args =>
      result(() =>
        repository
          .get(args.datasetId, args.profileIndex)
          .children(args.path, args.sort, args.offset, args.limit),
      ),
  )
  server.registerTool(
    'node_details',
    {
      description:
        'Get one call occurrence, descendant count and its ancestor stack. Positions are reconstructed from costs, not real timestamps.',
      inputSchema: z.object({...scope, path: nodePath}),
      annotations,
    },
    args => result(() => repository.get(args.datasetId, args.profileIndex).node(args.path)),
  )
  server.registerTool(
    'function_invocations',
    {
      description:
        'Get a bounded page of the most costly occurrences of one function, with node paths for further investigation. Does not return every full stack at once.',
      inputSchema: z.object({
        ...scope,
        ...paging,
        sort: z.enum(['total', 'self']).default('total'),
        functionKey,
      }),
      annotations,
    },
    args =>
      result(() =>
        repository
          .get(args.datasetId, args.profileIndex)
          .invocations(args.functionKey, args.sort, args.offset, args.limit),
      ),
  )
  server.registerTool(
    'function_callers',
    {
      description:
        'Aggregate costs and occurrences of a selected function by caller identity. These costs belong to the selected function, not the full caller.',
      inputSchema: z.object({...scope, ...paging, ...sorting, functionKey}),
      annotations,
    },
    args =>
      result(() =>
        repository
          .get(args.datasetId, args.profileIndex)
          .callers(args.functionKey, args.sort, args.offset, args.limit),
      ),
  )
  return server
}
