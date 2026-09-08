import { expect, test } from 'bun:test'
import { AcpDriver } from './index.ts'
import { AcpProcessTransport } from './process-transport.ts'

const source = `
let buffer='', creates=0, prompts=0, closes=0, lateCancelled=0, resumes=0;
const pending=new Map();
const creating=[];
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
  if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentInfo:{name:'wire-test',version:'1.0.0'},agentCapabilities:process.env.SCENARIO==='no-close'?{}:{loadSession:process.env.SCENARIO!=='no-load',sessionCapabilities:{close:{}}}});
  if(m.method==='session/load'){
   if(m.params.cwd!==process.cwd()||!Array.isArray(m.params.mcpServers))throw Error('missing load configuration');
   const history=[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'historical input'}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'historical output'}},{sessionUpdate:'tool_call',toolCallId:'old-tool',status:'completed'},{sessionUpdate:'usage_update',used:99999,size:200000}];
   if(process.env.SCENARIO==='history-limit')for(let i=0;i<4097;i++)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'tool_call',toolCallId:String(i)}}});
   for(const update of history)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update}});
   if(process.env.SCENARIO!=='lost-load')setTimeout(()=>reply(m.id,{}),20);
  }
  if(m.method==='session/close'){closes++;if(process.env.SCENARIO!=='lost-close')reply(m.id,{});}
  if(m.method==='close-probe')reply(m.id,{closes});
  if(m.method==='resume-probe')reply(m.id,{resumes});
  if(m.method==='session/resume'){
   resumes++;
   if(m.params.cwd!==process.cwd()||!Array.isArray(m.params.mcpServers))throw Error('missing resume configuration');
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'available_commands_update'}}});
   if(process.env.SCENARIO!=='lost-resume')setTimeout(()=>reply(m.id,{}),20);
  }
  if(m.method==='late-probe')reply(m.id,{lateCancelled});
  if(m.method==='session/list'){
   if(process.env.SCENARIO==='list-cycle')reply(m.id,{sessions:[],nextCursor:'repeat'});
   else if(process.env.SCENARIO==='list-item-limit')reply(m.id,m.params.cursor?{sessions:[{sessionId:'overflow'}]}:{sessions:Array.from({length:128},(_,i)=>({sessionId:'listed-'+i})),nextCursor:'next'});
   else if(process.env.SCENARIO==='list-limit')reply(m.id,{sessions:[],nextCursor:String(Number(m.params.cursor||0)+1)});
   else if(process.env.SCENARIO==='list-duplicate')reply(m.id,{sessions:[{sessionId:'same'}],nextCursor:m.params.cursor?null:'next'});
   else reply(m.id,m.params.cursor?{sessions:[{sessionId:'listed-2',title:'Second'}],nextCursor:null}:{sessions:[{sessionId:'listed-1',title:null}],nextCursor:'next'});
  }
  if(m.method==='session/new'){
   creates++;
   if(process.env.SCENARIO==='concurrent'){
    creating.push({id:m.id,sessionId:'native-'+creates});
    if(creating.length===2){
     for(const c of creating)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:c.sessionId,update:{sessionUpdate:'available_commands_update',owner:c.sessionId}}});
     for(const c of [...creating].reverse())reply(c.id,{sessionId:c.sessionId});
    }
    continue;
   }
   if(process.env.SCENARIO==='early-count-limit'||process.env.SCENARIO==='early-byte-limit'){
    const count=process.env.SCENARIO==='early-count-limit'?4097:9;
    const padding=process.env.SCENARIO==='early-byte-limit'?'x'.repeat(500000):'';
    for(let j=0;j<count;j++)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-'+creates,update:{sessionUpdate:'available_commands_update',padding}}});
   }
   if(process.env.SCENARIO==='early')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-'+creates,update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});
   if(process.env.SCENARIO!=='lost-create')reply(m.id,{sessionId:'native-'+creates});
  }
  if(m.method==='session/prompt'){
   prompts++; const s=m.params.sessionId;pending.set(s,m.id);
   if(process.env.SCENARIO==='exit'){process.exit(0);}
   send({jsonrpc:'2.0',id:'permission:'+s,method:'session/request_permission',params:{sessionId:s,toolCall:{toolCallId:'tool-1',title:'Allow once?'},options:[{optionId:'opaque-allow',kind:'allow_once'},{optionId:'opaque-deny',kind:'reject_once'}]}});
  }
  if(m.method==='session/cancel'&&process.env.SCENARIO==='late-permission')send({jsonrpc:'2.0',id:'late:'+m.params.sessionId,method:'session/request_permission',params:{sessionId:m.params.sessionId,toolCall:{toolCallId:'late-tool'},options:[{optionId:'late-allow',kind:'allow_once'}]}});
  else if(m.method==='session/cancel'&&process.env.SCENARIO!=='ignore-cancel')finish(m.params.sessionId,true);
  if(typeof m.id==='string'&&m.id.startsWith('late:')&&m.result){if(m.result.outcome.outcome==='cancelled')lateCancelled++;finish(m.id.slice(5),true);}
  if(m.method==='probe')reply(m.id,{creates,prompts});
  if(typeof m.id==='string'&&m.id.startsWith('permission:')&&m.result){
   const outcome=m.result.outcome;
   if(outcome.outcome==='selected'&&outcome.optionId!=='opaque-allow')throw Error('wrong native option');
   if(!['ignore-cancel','late-permission'].includes(process.env.SCENARIO))finish(m.id.slice('permission:'.length),outcome.outcome==='cancelled');
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

test('native history preserves event types without contaminating live output or usage', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    const handle = await driver.start(startRequest)
    for await (const event of driver.progress(handle))
      if (event.type === 'interaction')
        await driver.submitApproval(handle, {
          interactionId: event.data.interactionId,
          idempotencyKey: 'history-control',
          decision: 'approve',
        })
    const before = await transport.snapshot('native-1')
    const history = await driver.session({
      operation: 'history',
      sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
      afterSequence: 1,
    })
    expect(history.completeness).toBe('partial')
    expect(history.entries.map((entry) => entry.sequence)).toEqual([2, 3, 4])
    expect(history.entries.map((entry) => entry.data.update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'usage_update',
    ])
    expect(await transport.snapshot('native-1')).toEqual(before)
    const all = await transport.replay('native-1')
    expect(all.nativeUpdates[0].sessionUpdate).toBe('user_message_chunk')
    expect(all.updates).toEqual([])
  } finally {
    await transport.close()
  }
})

test('cleanup fences new operations while waiting for history replay', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    await driver.inspect()
    const replay = transport.replay('discovered')
    const closing = transport.cleanup('discovered')
    await expect(transport.replay('discovered')).rejects.toThrow('ACP_NATIVE_SESSION_CLOSING')
    await Promise.all([replay, closing])
    expect(await transport.request('close-probe', {})).toEqual({ closes: 1 })
    await transport.request('session/resume', { sessionId: 'discovered' })
    await transport.cleanup('discovered')
    expect(await transport.request('close-probe', {})).toEqual({ closes: 2 })
  } finally {
    await transport.close()
  }
})

test.each(['no-load', 'lost-load', 'history-limit'])(
  'native history fails without successful load: %s',
  async (scenario) => {
    const { transport, driver } = fixture(scenario)
    try {
      await transport.open()
      await driver.inspect()
      await expect(transport.replay('discovered')).rejects.toThrow()
      if (scenario === 'lost-load') {
        await expect(transport.replay('discovered')).rejects.toThrow()
        await expect(
          transport.request('session/prompt', { sessionId: 'discovered', prompt: [] })
        ).rejects.toThrow('ACP_NATIVE_SESSION_LOADING')
      }
    } finally {
      await transport.close()
    }
  }
)

test('native resume attaches discovery with configuration and coalesces calls', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    await driver.inspect()
    await Promise.all([
      transport.request('session/resume', { sessionId: 'discovered' }),
      transport.request('session/resume', { sessionId: 'discovered' }),
    ])
    expect(await transport.request('resume-probe', {})).toEqual({ resumes: 1 })
    await transport.cleanup('discovered')
    await transport.request('session/resume', { sessionId: 'discovered' })
    expect(await transport.request('resume-probe', {})).toEqual({ resumes: 2 })
    await transport.cleanup('discovered')
    expect(await transport.request('close-probe', {})).toEqual({ closes: 2 })
  } finally {
    await transport.close()
  }
})

test('reopening a completed native session preserves its execution result', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    const handle = await driver.start(startRequest)
    for await (const event of driver.progress(handle))
      if (event.type === 'interaction')
        await driver.submitApproval(handle, {
          interactionId: event.data.interactionId,
          idempotencyKey: 'resume-control',
          decision: 'approve',
        })
    const before = await transport.snapshot('native-1')
    expect(before.state).toBe('completed')
    await transport.cleanup('native-1')
    await transport.request('session/resume', { sessionId: 'native-1' })
    expect(await transport.snapshot('native-1')).toEqual(before)
    await transport.cleanup('native-1')
    expect(await transport.request('close-probe', {})).toEqual({ closes: 2 })
  } finally {
    await transport.close()
  }
})

test('uncertain native resume is fenced and does not silently retry', async () => {
  const { transport, driver } = fixture('lost-resume')
  try {
    await transport.open()
    await driver.inspect()
    await expect(transport.request('session/resume', { sessionId: 'discovered' })).rejects.toThrow()
    await expect(transport.request('session/resume', { sessionId: 'discovered' })).rejects.toThrow()
    await expect(
      transport.request('session/prompt', { sessionId: 'discovered', prompt: [] })
    ).rejects.toThrow('ACP_NATIVE_SESSION_RESUMING')
    expect(await transport.request('resume-probe', {})).toEqual({ resumes: 1 })
  } finally {
    await transport.close()
  }
})

test('native list collects all pages and normalizes nullable titles', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    await driver.inspect()
    expect(await transport.request('session/list', {})).toEqual({
      sessions: [{ sessionId: 'listed-1' }, { sessionId: 'listed-2', title: 'Second' }],
    })
    await expect(transport.request('session/list', { cursor: 'next' })).rejects.toThrow(
      'ACP_NATIVE_PARTIAL_LIST_UNSUPPORTED'
    )
  } finally {
    await transport.close()
  }
})

test.each(['list-cycle', 'list-limit', 'list-item-limit', 'list-duplicate'])(
  'native inventory rejects incomplete or inconsistent pagination: %s',
  async (scenario) => {
    const { transport, driver } = fixture(scenario)
    try {
      await transport.open()
      await driver.inspect()
      await expect(transport.request('session/list', {})).rejects.toThrow('ACP_NATIVE_LIST_')
    } finally {
      await transport.close()
    }
  }
)

test('native cleanup closes once, retains snapshots, and fences later prompts', async () => {
  const { transport, driver } = fixture()
  try {
    await transport.open()
    const handle = await driver.start(startRequest)
    await Promise.all([transport.cleanup('native-1'), transport.cleanup('native-1')])
    expect((await driver.status(handle)).state).toBe('cancelled')
    expect(await transport.request('close-probe', {})).toEqual({ closes: 1 })
    await transport.request('session/close', { sessionId: 'native-1' })
    expect(await transport.request('close-probe', {})).toEqual({ closes: 1 })
    await expect(
      transport.request('session/prompt', { sessionId: 'native-1', prompt: [] })
    ).rejects.toThrow('ACP_NATIVE_SESSION_CLOSING')
  } finally {
    await transport.close()
  }
})

test('cleanup cancels late native permissions before confirming close', async () => {
  const { transport, driver } = fixture('late-permission')
  try {
    await transport.open()
    const handle = await driver.start(startRequest)
    await transport.cleanup('native-1')
    expect((await driver.status(handle)).state).toBe('cancelled')
    expect(await transport.request('late-probe', {})).toEqual({ lateCancelled: 1 })
    expect(await transport.request('close-probe', {})).toEqual({ closes: 1 })
  } finally {
    await transport.close()
  }
})

test('cleanup fails explicitly when native close is not advertised', async () => {
  const { transport, driver } = fixture('no-close')
  try {
    await transport.open()
    await driver.inspect()
    await transport.createSession('unsupported')
    await expect(transport.cleanup('native-1')).rejects.toThrow('ACP_NATIVE_CLOSE_UNSUPPORTED')
    expect(await transport.request('close-probe', {})).toEqual({ closes: 0 })
  } finally {
    await transport.close()
  }
})

test('a lost close acknowledgement remains uncertain without repeating close', async () => {
  const { transport, driver } = fixture('lost-close')
  try {
    await transport.open()
    await driver.inspect()
    await transport.createSession('lost-close')
    await expect(transport.cleanup('native-1')).rejects.toThrow()
    await expect(transport.cleanup('native-1')).rejects.toThrow()
    expect(await transport.request('close-probe', {})).toEqual({ closes: 1 })
    await expect(
      transport.request('session/prompt', { sessionId: 'native-1', prompt: [] })
    ).rejects.toThrow('ACP_NATIVE_SESSION_CLOSING')
  } finally {
    await transport.close()
  }
})

test('concurrent creates retain their own early updates even when replies arrive in reverse order', async () => {
  const { transport, driver } = fixture('concurrent')
  try {
    await transport.open()
    await driver.inspect()
    const [first, duplicate, second] = await Promise.all([
      transport.createSession('first'),
      transport.createSession('first'),
      transport.createSession('second'),
    ])
    expect(duplicate).toEqual(first)
    expect(first.sessionId).not.toBe(second.sessionId)
    for (const { sessionId } of [first, second]) {
      await transport.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'execute' }],
      })
      for await (const update of transport.updates(sessionId)) {
        if (update.sessionUpdate === 'request_permission')
          await transport.respond(update.requestId, {
            outcome: { outcome: 'selected', optionId: 'opaque-allow' },
          })
      }
      const result = await transport.snapshot(sessionId)
      expect(result.state).toBe('completed')
      expect(
        result.output.nativeUpdates
          .filter((u) => u.sessionUpdate === 'available_commands_update')
          .map((u) => u.owner)
      ).toEqual([sessionId])
    }
    expect(await transport.request('probe', {})).toEqual({ creates: 2, prompts: 2 })
  } finally {
    await transport.close()
  }
})

test.each(['early-count-limit', 'early-byte-limit'])(
  'early update buffering fails closed at %s',
  async (scenario) => {
    const { transport, driver } = fixture(scenario)
    try {
      await transport.open()
      await driver.inspect()
      await expect(transport.createSession('bounded')).rejects.toThrow('ACP_PROCESS_PROTOCOL_ERROR')
      expect(transport.connectionState()).toBe('disconnected')
      await expect(transport.createSession('bounded')).rejects.toThrow('ACP_PROCESS_PROTOCOL_ERROR')
    } finally {
      await transport.close()
    }
  }
)
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
