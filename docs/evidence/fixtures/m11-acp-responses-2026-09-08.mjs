import { createServer } from 'node:http'
let calls = 0
const server = createServer((request, response) => {
  request.resume()
  if (request.url === '/probe') {
    response.end(JSON.stringify({ calls }))
    return
  }
  if (request.url !== '/v1/responses' || request.method !== 'POST') {
    response.writeHead(404).end()
    return
  }
  calls++
  // Cancellation probe: keep the native model request pending until its caller aborts.
  if (process.env.M11_HOLD_RESPONSES === '1') return
  const permissionCount = process.env.M11_PERMISSION_PROBE === '2' ? 2 : 1
  const permission =
    ['1', '2'].includes(process.env.M11_PERMISSION_PROBE) && calls <= permissionCount
  const item = permission
    ? {
        id: `fc_m11_permission_${calls}`,
        type: 'function_call',
        call_id: `call_m11_permission_${calls}`,
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: "printf 'approved\\n' >> /tmp/m11-permission-proof",
          sandbox_permissions: 'require_escalated',
          justification: 'Write the isolated M11 permission marker.',
        }),
        status: 'completed',
      }
    : {
        id: `msg_${calls}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'M11 isolated ACP response.', annotations: [] }],
      }
  const result = {
    id: `resp_${calls}`,
    object: 'response',
    created_at: 1788838800,
    status: 'completed',
    model: 'gpt-5.4',
    output: [item],
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type, fields) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  send('response.created', { response: { ...result, status: 'in_progress', output: [] } })
  if (permission) {
    send('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    })
    send('response.function_call_arguments.delta', {
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    })
    send('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    })
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: result })
    response.end()
    return
  }
  send('response.output_item.added', {
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  })
  send('response.content_part.added', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  })
  send('response.output_text.delta', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: item.content[0].text,
  })
  send('response.output_text.done', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text: item.content[0].text,
  })
  send('response.content_part.done', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: item.content[0],
  })
  send('response.output_item.done', { output_index: 0, item })
  send('response.completed', { response: result })
  response.end()
})
server.listen(8787, '127.0.0.1')
setTimeout(() => server.close(), 180000)
