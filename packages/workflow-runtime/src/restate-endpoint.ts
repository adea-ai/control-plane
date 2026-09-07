import http from 'node:http'
import * as restate from '@restatedev/restate-sdk'
import {
  ExecutionWorkflowInputSchema,
  type ExecutionWorkflowInput,
} from '@control-plane/orchestration'
import {
  runExecutionLifecycle,
  validateInteractionResponse,
  type ActivityRaceResult,
  type ExecutionLifecycleActivities,
  type ExecutionWorkflowResult,
  type TerminalControl,
  type WorkflowInteractionResponse,
} from './execution-workflow.js'

export const restateWorkflowName = 'execution-lifecycle'
export const restatePort = 9080
const terminalControlPromiseName = 'terminal-control'

export interface RestateEndpointHandle {
  readonly run: () => Promise<void>
  readonly shutdown: () => Promise<void>
}

export interface RestateEndpointFactory {
  create(): Promise<RestateEndpointHandle>
}

const unavailable = async (): Promise<never> => {
  throw new Error('EXECUTION_ACTIVITY_PORT_NOT_CONFIGURED')
}

const defaultActivities: ExecutionLifecycleActivities = {
  ensureAttempt: unavailable,
  persistStatus: unavailable,
  dispatch: unavailable,
  applyInteraction: unavailable,
  runGraphSegment: unavailable,
  resumeGraphSegment: unavailable,
  continueGraphSegment: unavailable,
  cancelActive: unavailable,
  cleanup: unavailable,
}

const interactionPromiseName = (interactionId: string) => `interaction:${interactionId}`

export function createRestateWorkflowDefinition(
  activities: ExecutionLifecycleActivities = defaultActivities
) {
  return restate.workflow({
    name: restateWorkflowName,
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: unknown): Promise<ExecutionWorkflowResult> =>
        runRestateExecution(ctx, input, activities),
      respondToInteraction: async (
        ctx: restate.WorkflowSharedContext,
        response: WorkflowInteractionResponse
      ): Promise<void> => {
        // Reject malformed values before they permanently resolve the durable promise.
        try {
          validateInteractionResponse(response)
        } catch {
          throw new restate.TerminalError('INTERACTION_SIGNAL_VALUE_INVALID', { errorCode: 400 })
        }
        await ctx
          .promise<WorkflowInteractionResponse>(interactionPromiseName(response.interactionId))
          .resolve(response)
      },
      cancelExecution: async (ctx: restate.WorkflowSharedContext): Promise<void> => {
        await ctx.promise<TerminalControl>(terminalControlPromiseName).resolve({ cancelled: true })
      },
    },
  })
}

async function runRestateExecution(
  ctx: restate.WorkflowContext,
  inputValue: unknown,
  activities: ExecutionLifecycleActivities
): Promise<ExecutionWorkflowResult> {
  const input: ExecutionWorkflowInput = ExecutionWorkflowInputSchema.parse(inputValue)
  const deadlineDelay = Math.max(0, Date.parse(input.deadlineAt) - (await ctx.date.now()))
  const terminalControl = ctx.promise<TerminalControl>(terminalControlPromiseName)
  const deadlineControl = ctx
    .sleep(deadlineDelay, 'execution-deadline')
    .map(() => ({ deadlineReached: true }) as const)
  const terminalOutcome = () =>
    terminalControl.get().map((control) => ({ type: 'terminal', control }) as const)
  const deadlineOutcome = () =>
    deadlineControl.map((control) => ({ type: 'terminal', control }) as const)
  const waitForInteraction = (interactionId: string): Promise<WorkflowInteractionResponse> =>
    ctx.promise<WorkflowInteractionResponse>(interactionPromiseName(interactionId)).get()
  return runExecutionLifecycle(input, createDurableActivities(ctx, activities), {
    waitForInteraction,
    raceActivity: async <Value>(activity: Promise<Value>) =>
      restate.RestatePromise.race([
        (activity as restate.RestatePromise<Value>).map(
          (value) => ({ type: 'activity', value }) as const
        ),
        terminalOutcome(),
        deadlineOutcome(),
      ]) as Promise<ActivityRaceResult<Value>>,
    checkTerminal: async () => {
      const outcome = await restate.RestatePromise.race([
        terminalOutcome(),
        deadlineOutcome(),
        ctx.sleep(0, 'terminal-control-check').map(() => ({ type: 'clear' }) as const),
      ])
      return outcome.type === 'terminal' ? outcome.control : undefined
    },
  })
}

function createDurableActivities(
  ctx: restate.WorkflowContext,
  activities: ExecutionLifecycleActivities
): ExecutionLifecycleActivities {
  return {
    ensureAttempt: (input) => ctx.run('ensure-attempt', () => activities.ensureAttempt(input)),
    persistStatus: (input) => ctx.run('persist-status', () => activities.persistStatus(input)),
    dispatch: (input) => ctx.run('dispatch', () => activities.dispatch(input)),
    applyInteraction: (input) =>
      ctx.run('apply-interaction', () => activities.applyInteraction(input)),
    runGraphSegment: (input) =>
      ctx.run('run-graph-segment', () => activities.runGraphSegment(input)),
    resumeGraphSegment: (input) =>
      ctx.run('resume-graph-segment', () => activities.resumeGraphSegment(input)),
    continueGraphSegment: (input) =>
      ctx.run('continue-graph-segment', () => activities.continueGraphSegment(input)),
    cancelActive: (input) => ctx.run('cancel-active', () => activities.cancelActive(input)),
    cleanup: (input) => ctx.run('cleanup', () => activities.cleanup(input)),
  }
}

export function createRestateEndpointFactory(
  options: {
    readonly port?: number
    readonly host?: string
    readonly activities?: ExecutionLifecycleActivities
    readonly requestIdentityPublicKey?: string
  } = {}
): RestateEndpointFactory {
  return {
    async create() {
      const restateHandler = restate.createEndpointHandler(createRestateEndpointOptions(options))
      const server = http.createServer((request, response) => {
        if (request.url === '/health' || request.url === '/ready') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ status: 'ok', service: 'workflow-runtime' }))
          return
        }
        restateHandler(request, response)
      })
      const port = options.port ?? Number(process.env['PORT'] ?? restatePort)
      const host = options.host ?? '0.0.0.0'
      return {
        run: () =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, host, () => {
              server.off('error', reject)
              resolve()
            })
          }),
        shutdown: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      }
    },
  }
}

export function createRestateEndpointOptions(
  options: {
    readonly activities?: ExecutionLifecycleActivities
    readonly requestIdentityPublicKey?: string
  } = {}
) {
  return {
    services: [createRestateWorkflowDefinition(options.activities)],
    bidirectional: false,
    ...(options.requestIdentityPublicKey === undefined
      ? {}
      : { identityKeys: [options.requestIdentityPublicKey] }),
  }
}
