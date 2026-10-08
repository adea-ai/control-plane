// Local qualification entry only. No production route, credentials, provider, or runtime registration.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, createRegistry, defineTask } from '@earendil-works/pi-durable'
import { CloudflarePiDurableOwner, openCloudflarePiStorage, stableJson } from '../src/index.ts'

const id = (prefix) => `${prefix}_00000000000000000000000001`
const digest = `sha256:${'a'.repeat(64)}`
const request = {
  executionId: id('exe'),
  attemptId: id('att'),
  idempotencyKey: 'qualification-start',
  executionPlan: {
    schemaVersion: 2,
    executionPlanId: id('pln'),
    contentDigest: digest,
    runtimeRequirements: [],
    correlation: { workspaceId: id('wsp') },
    constraints: {
      limits: {
        budget: { currency: 'USD', maximumMicrounits: 100 },
        tokens: { maximumTotal: 100 },
      },
    },
  },
  attemptBudget: {
    schemaVersion: 1,
    workspaceId: id('wsp'),
    executionId: id('exe'),
    attemptId: id('att'),
    executionPlanId: id('pln'),
    executionPlanDigest: digest,
    reservationKey: `runtime-attempt:${id('att')}`,
    currency: 'USD',
    maximumMicrounits: 100,
    maximumTokens: 100,
  },
}
const accepted = {
  schemaVersion: 1,
  canonicalActorPrincipalId: 'user:00000000-0000-0000-0000-000000000001',
  request,
}

function taskDefinitions(version, beforeCommit) {
  const task = defineTask({
    name: 'cloudflare-qualification',
    version,
    initial: () => ({ phase: 'checkpoint' }),
    phases: {
      checkpoint: async (runningTask, runtime, context) => {
        await beforeCommit?.(runningTask.input)
        return runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'completed', result: runningTask.input },
          }),
          context
        )
      },
    },
    abort: async (_runningTask, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    migrate(input, checkpoint, fromVersion) {
      if (fromVersion !== 1 || version !== 2) throw new Error('UNSUPPORTED_PROBE_VERSION')
      return { input, checkpoint }
    },
  })
  const registry = createRegistry()
  registry.install({ name: 'cloudflare-qualification', tasks: [task] })
  return { task, registry }
}

export class RecoveryOwner {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.bootId = crypto.randomUUID()
    this.pins = {
      schemaVersion: 1,
      adapterVersion: '0.1.0',
      runtimeVersion: env.RUNTIME_VERSION,
      configurationDigest: digest,
      workspaceId: id('wsp'),
      conversationId: ctx.id.toString(),
      agentId: id('agt'),
    }
    this.owner = new CloudflarePiDurableOwner(ctx, {
      context: BACKGROUND_CONTEXT,
      pins: this.pins,
      now: () =>
        Date.now() +
        (ctx.id.toString() === env.OWNER.idFromName('context-alarm').toString() ? 50 : 60_000),
      authority: {
        async readAccepted() {
          return structuredClone(accepted)
        },
        assertCurrent: async (task, pins) => {
          if (
            env.REVOKED === 'true' ||
            stableJson(task) !== stableJson(accepted) ||
            pins.workspaceId !== id('wsp') ||
            pins.conversationId !== ctx.id.toString()
          )
            throw new Error('QUALIFICATION_AUTHORITY_DENIED')
        },
      },
      sessionAuthority: {
        assertCurrent: async (sessions, owner) => {
          if (
            env.SESSION_REVOKED === 'true' ||
            owner.conversationId !== env.OWNER.idFromName('context-a').toString()
          )
            throw new Error('QUALIFICATION_SESSION_AUTHORITY_DENIED')
          for (const session of sessions) {
            if (
              session.binding.schemaVersion !== 1 ||
              session.binding.sessionId !== id('ses') ||
              session.binding.nativeConversationId !== 1 ||
              session.binding.attemptId !== request.attemptId ||
              stableJson(session.task) !== stableJson(accepted)
            )
              throw new Error('QUALIFICATION_SESSION_BINDING_DENIED')
          }
        },
      },
      reconciliation: env.EFFECTS
        ? {
            readSettlement: async (task, owner, recoveryEpoch) => {
              const response = await env.EFFECTS.fetch('http://fixture/receipt')
              if (response.status === 404) return undefined
              if (!response.ok) throw new Error('QUALIFICATION_LEDGER_UNAVAILABLE')
              const evidence = await response.json()
              if (stableJson(evidence.task) !== stableJson(task))
                throw new Error('QUALIFICATION_LEDGER_IDENTITY_DENIED')
              return {
                schemaVersion: 1,
                receiptRef: evidence.receiptRef,
                task: evidence.task,
                owner,
                recoveryEpoch,
                disposition: 'completed',
                result: evidence.result,
              }
            },
          }
        : undefined,
      openEngine: async (storage) => {
        let activeTask, activeBeforeEffect
        const definitions = taskDefinitions(
          1,
          env.EFFECTS
            ? async (input) => {
                if (
                  !activeTask ||
                  !activeBeforeEffect ||
                  input.attemptId !== activeTask.request.attemptId ||
                  input.planDigest !== activeTask.request.executionPlan.contentDigest
                )
                  throw new Error('QUALIFICATION_PENDING_TASK_NOT_AUTHORIZED')
                await activeBeforeEffect()
                // The real native Pi task phase stays running while its controlled effect ACK is held.
                await env.EFFECTS.fetch('http://fixture/effect', {
                  method: 'POST',
                  body: JSON.stringify({
                    task: activeTask,
                    result: {
                      outcome: 'completed',
                      output: input,
                      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
                      artifacts: [],
                    },
                  }),
                })
              }
            : undefined
        )
        const harness = await Harness.open(
          storage,
          { models: createModels(), registry: definitions.registry },
          BACKGROUND_CONTEXT
        )
        return {
          run: async (task, beforeEffect) => {
            activeTask = task
            activeBeforeEffect = beforeEffect
            await beforeEffect()
            const root = await harness.root(BACKGROUND_CONTEXT)
            const taskId = await root.commit(
              (tx) =>
                tx.createTask(
                  definitions.task,
                  {
                    planDigest: task.request.executionPlan.contentDigest,
                    attemptId: task.request.attemptId,
                  },
                  { ownership: { kind: 'conversation' } }
                ),
              BACKGROUND_CONTEXT
            )
            const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT)
            const result = {
              outcome: 'completed',
              output: settled.state.outcome.result,
              usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
              artifacts: [],
            }
            return result
          },
          close: async () => {
            if (env.EFFECTS) await env.EFFECTS.fetch('http://fixture/close', { method: 'POST' })
            await harness.close(BACKGROUND_CONTEXT)
          },
        }
      },
    })
  }

  async fetch(httpRequest) {
    const url = new URL(httpRequest.url)
    const action = url.pathname.split('/')[2]
    if (action === 'socket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].serializeAttachment(this.pins)
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    // Qualification-only public facade routes; not a production Worker transport.
    if (action === 'public-start')
      return Response.json(await this.owner.runtimeAdapter().start(request))
    if (action === 'public-status' || action === 'public-progress') {
      const input = await httpRequest.json()
      const adapter = this.owner.runtimeAdapter()
      if (action === 'public-status') return Response.json(await adapter.status(input.handle))
      const events = []
      for await (const event of adapter.progress(input.handle, {
        afterSequence: input.afterSequence,
      }))
        events.push(event)
      return Response.json(events)
    }
    if (action === 'session-bind') {
      await this.owner.bindSession({
        schemaVersion: 1,
        sessionId: id('ses'),
        nativeConversationId: 1,
        attemptId: request.attemptId,
      })
      return Response.json({ bound: true })
    }
    if (action === 'session-load' || action === 'session-list')
      return Response.json(
        await this.owner
          .runtimeAdapter()
          .session(
            action === 'session-list'
              ? { operation: 'list' }
              : { operation: 'load', sessionId: id('ses') }
          )
      )
    if (action === 'accept') return Response.json(await this.owner.accept(request))
    if (action === 'wake') {
      await this.owner.alarm()
      return Response.json(await this.owner.read(request.attemptId))
    }
    if (action === 'reconcile') return Response.json(await this.owner.reconcile(request.attemptId))
    if (action === 'read')
      return Response.json({
        ...(await this.owner.read(request.attemptId)),
        bootId: this.bootId,
        revision: this.env.REVISION,
      })
    if (action === 'checkpoint' || action === 'finish') {
      const storage = await openCloudflarePiStorage(this.ctx.storage)
      const definitions = taskDefinitions(Number(this.env.TASK_VERSION))
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: definitions.registry },
        BACKGROUND_CONTEXT
      )
      try {
        const root = await harness.root(BACKGROUND_CONTEXT)
        if (action === 'checkpoint') {
          const taskId = await root.commit(
            (tx) =>
              tx.createTask(
                definitions.task,
                { exactPlanDigest: digest },
                { ownership: { kind: 'conversation' } }
              ),
            BACKGROUND_CONTEXT
          )
          return Response.json({
            taskId,
            conversationId: root.id,
            state: (await harness.getTask(taskId, BACKGROUND_CONTEXT)).state.status,
          })
        }
        const taskId = Number(url.searchParams.get('taskId'))
        return Response.json({
          conversationId: root.id,
          task: await harness.waitForTask(taskId, BACKGROUND_CONTEXT),
        })
      } finally {
        await harness.close(BACKGROUND_CONTEXT)
      }
    }
    if (action === 'summary') {
      const storage = await openCloudflarePiStorage(this.ctx.storage)
      try {
        return Response.json({
          conversations: (await storage.scanConversations({}, 100, undefined, BACKGROUND_CONTEXT))
            .items,
          nativeTasks: (await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)).items,
          events: this.ctx.storage.sql.exec('SELECT * FROM cp_pi_events').toArray(),
        })
      } finally {
        await storage.close(BACKGROUND_CONTEXT)
      }
    }
    return new Response('Unknown qualification action', { status: 404 })
  }

  async webSocketMessage(socket) {
    if (stableJson(socket.deserializeAttachment()) !== stableJson(this.pins))
      throw new Error('QUALIFICATION_SOCKET_SCOPE_MISMATCH')
    socket.send(
      JSON.stringify({
        bootId: this.bootId,
        pins: this.pins,
        epoch: this.ctx.storage.sql.exec('SELECT epoch FROM cp_pi_owner').toArray()[0].epoch,
      })
    )
  }

  alarm() {
    return this.owner.alarm()
  }
}

export default {
  fetch(httpRequest, env) {
    const name = new URL(httpRequest.url).pathname.split('/')[1]
    if (!['context-a', 'context-b', 'context-alarm'].includes(name))
      return new Response('Unknown fixture binding', { status: 404 })
    return env.OWNER.get(env.OWNER.idFromName(name)).fetch(httpRequest)
  },
}
