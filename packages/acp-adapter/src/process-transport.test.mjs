import { expect, test } from 'bun:test'
import { AcpDriver } from './index.ts'
import { AcpProcessTransport } from './process-transport.ts'

const source = `
let buffer='', creates=0, prompts=0;
const pending=new Map();
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
const finish=(sessionId,cancelled=false)=>{
 const id=pending.get(sessionId); if(id===undefined)return; pending.delete(sessionId);
 if(!cancelled){
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'native output'}}}});
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'usage_update',used:99999,size:200000}}});
 }
 reply(id,{stopReason:cancelled?'cancelled':'end_turn',...(process.env.SCENARIO==='missing-usage'?{}:{usage:{inputTokens:11,outputTokens:3,cachedReadTokens:7}})});
};
process.stdin.on('data',chunk=>{
 buffer+=chunk; let i;
 while((i=buffer.indexOf('\\n'))!==-1){
  const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
  if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentInfo:{name:'wire-test',version:'1.0.0'},agentCapabilities:{}});
  if(m.method==='session/new'){
   creates++;
   if(process.env.SCENARIO==='early')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-'+creates,update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});
   if(process.env.SCENARIO!=='lost-create')reply(m.id,{sessionId:'native-'+creates});
  }
  if(m.method==='session/prompt'){
   prompts++; const s=m.params.sessionId;pending.set(s,m.id);
   if(process.env.SCENARIO==='exit'){process.exit(0);}
   send({jsonrpc:'2.0',id:'permission:'+s,method:'session/request_permission',params:{sessionId:s,toolCall:{toolCallId:'tool-1',title:'Allow once?'},options:[{optionId:'opaque-allow',kind:'allow_once'},{optionId:'opaque-deny',kind:'reject_once'}]}});
  }
  if(m.method==='session/cancel'&&process.env.SCENARIO!=='ignore-cancel')finish(m.params.sessionId,true);
  if(m.method==='probe')reply(m.id,{creates,prompts});
  if(typeof m.id==='string'&&m.id.startsWith('permission:')&&m.result){
   const outcome=m.result.outcome;
   if(outcome.outcome==='selected'&&outcome.optionId!=='opaque-allow')throw Error('wrong native option');
   if(process.env.SCENARIO!=='ignore-cancel')finish(m.id.slice('permission:'.length),outcome.outcome==='cancelled');
  }
 }
});
`
const startRequest = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  idempotencyKey: 'native:start',
  executionPlan: {
    schemaVersion: 1,
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    runtimeRequirements: [],
  },
}
function fixture(scenario = 'complete') {
  const transport = new AcpProcessTransport({
    executablePath: process.execPath,
    args: ['-e', source],
    cwd: import.meta.dir,
    environment: { SCENARIO: scenario },
    turnTimeoutMs: 4000,
    requestTimeoutMs: 1000,
  })
  const driver = new AcpDriver({
    transport,
    protocolVersion: 1,
    adapterVersion: '1.0.0',
    externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
    interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
  })
  return { transport, driver }
}

test.each(['complete', 'early'])(
  'native process transport drives approval, streaming, final usage, and duplicate start through AcpDriver: %s',
  async (scenario) => {
    const { transport, driver } = fixture(scenario)
    try {
      await transport.open()
      const handle = await driver.start(startRequest)
      expect(await driver.start(startRequest)).toEqual(handle)
      const events = []
      for await (const event of driver.progress(handle)) {
        events.push(event)
        if (event.type === 'interaction')
          await driver.submitApproval(handle, {
            interactionId: event.data.interactionId,
            idempotencyKey: 'native:approve',
            decision: 'approve',
          })
      }
      const status = await driver.status(handle)
      expect(status.state).toBe('completed')
      expect(status.result.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 })
      expect(status.result.output).toMatchObject({
        text: 'native output',
        nativeUsage: { cachedReadTokens: 7 },
      })
      if (scenario === 'early')
        expect(
          status.result.output.nativeUpdates.some(
            (update) => update.sessionUpdate === 'available_commands_update'
          )
        ).toBe(true)
      expect(events.some((e) => e.type === 'output')).toBe(true)
      expect(await transport.request('probe', {})).toEqual({ creates: 1, prompts: 1 })
    } finally {
      await transport.close()
    }
  }
)

test('a lost native create response does not retry the same token', async () => {
  const { transport, driver } = fixture('lost-create')
  try {
    await transport.open()
    await driver.inspect()
    await expect(transport.createSession('stable-token')).rejects.toThrow(
      'ACP_PROCESS_REQUEST_TIMEOUT'
    )
    await expect(transport.createSession('stable-token')).rejects.toThrow(
      'ACP_PROCESS_REQUEST_TIMEOUT'
    )
    expect(await transport.request('probe', {})).toEqual({ creates: 1, prompts: 0 })
  } finally {
    await transport.close()
  }
})

test('cleanup is bounded separately from an uncooperative native turn', async () => {
  const { transport, driver } = fixture('ignore-cancel')
  try {
    await transport.open()
    await driver.start(startRequest)
    await expect(transport.cleanup('native-1')).rejects.toThrow('ACP_NATIVE_CLEANUP_TIMEOUT')
    expect((await transport.snapshot('native-1')).state).toBe('running')
  } finally {
    await transport.close()
  }
})

test('an already-aborted create does not consume its token or dispatch a native operation', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    await driver.inspect()
    const controller = new AbortController()
    controller.abort()
    await expect(transport.createSession('not-dispatched', controller.signal)).rejects.toThrow(
      'ACP_NATIVE_ABORTED'
    )
    expect(await transport.request('probe', {})).toEqual({ creates: 0, prompts: 0 })
    expect(await transport.createSession('not-dispatched')).toEqual({ sessionId: 'native-1' })
  } finally {
    await transport.close()
  }
})

test('cleanup abort releases its waiter without claiming native cancellation', async () => {
  const { transport, driver } = fixture('ignore-cancel')
  try {
    await transport.open()
    await driver.start(startRequest)
    const controller = new AbortController()
    const cleanup = transport.cleanup('native-1', controller.signal)
    controller.abort()
    await expect(cleanup).rejects.toThrow('ACP_NATIVE_ABORTED')
    expect((await transport.snapshot('native-1')).state).toBe('running')
  } finally {
    await transport.close()
  }
})

test('native process cancellation resolves pending permissions and waits for the prompt outcome', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    const handle = await driver.start(startRequest)
    for await (const event of driver.progress(handle)) {
      if (event.type === 'interaction')
        await driver.cancel(handle, {
          idempotencyKey: 'native:cancel',
          requestedAt: new Date().toISOString(),
        })
    }
    expect((await driver.status(handle)).state).toBe('cancelled')
  } finally {
    await transport.close()
  }
})

test.each(['missing-usage', 'exit'])(
  'native process does not fabricate completion after %s',
  async (scenario) => {
    const { transport, driver } = fixture(scenario)
    try {
      await transport.open()
      const handle = await driver.start(startRequest)
      for await (const event of driver.progress(handle)) {
        if (event.type === 'interaction')
          await driver.submitApproval(handle, {
            interactionId: event.data.interactionId,
            idempotencyKey: 'native:approve',
            decision: 'approve',
          })
      }
      const status = await driver.status(handle)
      expect(status.state).toBe(scenario === 'exit' ? 'unknown' : 'failed')
      if (scenario !== 'exit') expect(status.error.retryable).toBe(false)
      else expect(status.result).toBeUndefined()
    } finally {
      await transport.close()
    }
  }
)
