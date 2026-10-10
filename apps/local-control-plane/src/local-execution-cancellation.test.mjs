import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify, ControlApiFixtures } from '@control-plane/contracts'
import { createControlApiApplication } from '@control-plane/control-api'
import { DurableExecutionCancellationService } from '@control-plane/domain'
import {
  assertSqliteWorkflowExecutionReference,
  SqliteExecutionCancellationRepository,
} from '@control-plane/sqlite-persistence'
import {
  EmbeddedExecutionWorkflowDispatcher,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import { createLocalGraphToolFixture } from './local-graph-tool-fixture.mjs'

const CALLER = 'svc_graph-tool-test'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Canonical command identifiers (cmd_ + 26 Crockford characters), deterministic per index. */
function canonicalCommandId(index) {
  let value = index
  let suffix = ''
  for (let position = 0; position < 26; position++) {
    suffix = ALPHABET[value % 32] + suffix
    value = Math.floor(value / 32)
  }
  return `cmd_${suffix}`
}
const TOKEN = 'local-execution-cancellation-token'
const metadata = {
  serviceName: 'local-control-plane',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'local-execution-cancellation-test',
}

// The accepted record carries workspace and project only; the acceptance fixture's execution scope must not leak in.
const { executionScope: _acceptanceScope, ...BASE_REQUEST } =
  ControlApiFixtures.executionAcceptance.request

function cancelCommand(fixture, { commandId, idempotencyKey, executionId, callerId = CALLER }) {
  const payload = { executionId }
  return {
    ...BASE_REQUEST,
    caller: { servicePrincipalId: callerId },
    operation: 'execution.cancel',
    workspaceId: fixture.operation.workspaceId,
    projectId: fixture.plan.correlation.projectId,
    commandId,
    idempotencyKey,
    issuedAt: fixture.at,
    payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
    payload,
  }
}

/** The durable receipt key: the scope fields the repository is keyed on. */
function receiptScope(command) {
  return {
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    caller: command.caller,
    operation: command.operation,
    idempotencyKey: command.idempotencyKey,
  }
}

test('the Local execution cancel route accepts the command through the composed durable service and replays it idempotently', async () => {
  const fixture = await createLocalGraphToolFixture({ graphInput: { cancel: 'proof' } })
  const workflowJobs = new WorkflowJobStore(fixture.persistence, {
    beforeEnqueue: assertSqliteWorkflowExecutionReference,
  })
  const dispatcher = new EmbeddedExecutionWorkflowDispatcher({
    store: workflowJobs,
    now: () => fixture.at,
  })
  const cancellation = new DurableExecutionCancellationService(
    new SqliteExecutionCancellationRepository(fixture.persistence),
    fixture.api.commandRepository,
    dispatcher,
    () => fixture.at
  )
  const app = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: {
      authenticate: async (request, requiredScopes) => {
        if (
          request.headers.authorization !== `Bearer ${TOKEN}` ||
          !requiredScopes.every((scope) => ['execution:cancel'].includes(scope))
        )
          throw new Error('TEST_SERVICE_AUTHENTICATION_REJECTED')
        return {
          principalId: CALLER,
          workspaceIds: [fixture.operation.workspaceId],
          projectIds: [fixture.plan.correlation.projectId],
          scopes: ['execution:cancel'],
        }
      },
    },
    executionCancellationService: cancellation,
  })
  try {
    const executionId = fixture.operation.executionId
    const first = cancelCommand(fixture, {
      commandId: canonicalCommandId(1),
      idempotencyKey: 'local-cancel-proof-0001',
      executionId,
    })
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/executions/cancel',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: first,
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json().data).toMatchObject({ executionId, status: 'accepted', replayed: false })

    // The durable receipt is the fence: it survives the response and is visible to a reader.
    const receipt = await new SqliteExecutionCancellationRepository(fixture.persistence).get(
      receiptScope(first)
    )
    expect(receipt).toBeDefined()

    // Exact replay returns the same acceptance without a second command.
    const replayed = await app.inject({
      method: 'POST',
      url: '/v1/executions/cancel',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: first,
    })
    expect(replayed.statusCode).toBe(202)
    expect(replayed.json().data).toMatchObject({ status: 'accepted', replayed: true })
  } finally {
    await app.close()
    await fixture.cleanup()
  }
})

test('a cancel from a caller other than the accepting principal is refused before any receipt is written', async () => {
  const fixture = await createLocalGraphToolFixture({ graphInput: { cancel: 'refusal' } })
  const workflowJobs = new WorkflowJobStore(fixture.persistence, {
    beforeEnqueue: assertSqliteWorkflowExecutionReference,
  })
  const app = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: {
      authenticate: async () => ({
        principalId: 'svc_intruder',
        workspaceIds: [fixture.operation.workspaceId],
        projectIds: [fixture.plan.correlation.projectId],
        scopes: ['execution:cancel'],
      }),
    },
    executionCancellationService: new DurableExecutionCancellationService(
      new SqliteExecutionCancellationRepository(fixture.persistence),
      fixture.api.commandRepository,
      new EmbeddedExecutionWorkflowDispatcher({ store: workflowJobs, now: () => fixture.at }),
      () => fixture.at
    ),
  })
  try {
    const refused = cancelCommand(fixture, {
      commandId: canonicalCommandId(2),
      idempotencyKey: 'local-cancel-refusal-0001',
      executionId: fixture.operation.executionId,
      callerId: 'svc_intruder',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/executions/cancel',
      headers: { authorization: 'Bearer any' },
      payload: refused,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('EXECUTION_CANCELLATION_SCOPE_REJECTED')
    expect(
      await new SqliteExecutionCancellationRepository(fixture.persistence).get(
        receiptScope(refused)
      )
    ).toBeUndefined()
  } finally {
    await app.close()
    await fixture.cleanup()
  }
})
