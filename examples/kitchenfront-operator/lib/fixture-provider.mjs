import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {DYNAMIC_TOOLS} from './fixtures.mjs';

const EXPECTED_TOOL_NAMES = Object.freeze(['get_demo_case', 'prepare_demo_proposal']);
const CODEX_INPUT_SCHEMA_UNSUPPORTED_KEYS = new Set(['maxLength']);
const CASE_BY_ID = Object.freeze({
  quotation: {
    match: /\brobin\b|\bquotation\b/i,
    recipient: 'robin@example.org',
    subject: 'Following up on quotation DEMO-Q017',
    body: 'Hello Robin, I’m following up on quotation DEMO-Q017 for your Shaker kitchen. Would you like to discuss the proposed scope or any questions?',
    answer: 'Fixture response for Robin: a quotation follow-up proposal is ready for review. No email was sent, and no quotation total or attachment was supplied.',
  },
  reply: {
    match: /\balex\b/i,
    recipient: 'alex@example.com',
    subject: 'Your kitchen enquiry',
    body: 'Hello Alex, thank you for sharing your kitchen plans. What budget and timing do you have in mind so we can suggest suitable next steps?',
    answer: 'Fixture response for Alex: a customer reply proposal is ready for review. No email was sent.',
  },
  consultation: {
    match: /\bcasey\b/i,
    recipient: 'casey@example.net',
    subject: undefined,
    body: 'Hello Casey, a fictional consultation opening is shown for 13 October at 11:00 London time. Would that suit you?',
    answer: 'Fixture response for Casey: a consultation proposal is ready for review for a seeded fictional slot. No real appointment was booked.',
  },
});

const responseEvents = (id, outputItem, inputTokens = 100, outputTokens = 12, beforeDone = []) => [
  {type: 'response.created', response: {id}},
  ...beforeDone,
  {type: 'response.output_item.done', item: outputItem},
  {type: 'response.completed', response: {
    id,
    status: 'completed',
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: null,
      output_tokens: outputTokens,
      output_tokens_details: null,
      total_tokens: inputTokens + outputTokens,
    },
  }},
];

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function schemaAsCodexSerializes(value) {
  if (Array.isArray(value)) return value.map(schemaAsCodexSerializes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !CODEX_INPUT_SCHEMA_UNSUPPORTED_KEYS.has(key))
      .map(([key, child]) => [key, schemaAsCodexSerializes(child)]));
  }
  return value;
}

function expectedResponsesLiteToolCatalogue() {
  return [{
    type: 'namespace',
    name: 'functions',
    description: '',
    tools: FIXTURE_TOOL_CATALOGUE,
  }];
}

function catalogueLocation(body) {
  if (Array.isArray(body?.tools)) {
    const additionalTools = Array.isArray(body?.input)
      ? body.input.filter(item => item?.type === 'additional_tools')
      : [];
    return additionalTools.length === 0
      ? {mode: 'responses', tools: body.tools, validEnvelope: true}
      : {mode: 'invalid', tools: body.tools, validEnvelope: false};
  }
  const input = Array.isArray(body?.input) ? body.input : [];
  const additionalTools = input
    .map((item, index) => ({item, index}))
    .filter(({item}) => item?.type === 'additional_tools');
  if (additionalTools.length !== 1) return {mode: 'invalid', tools: null, validEnvelope: false};
  const [{item, index}] = additionalTools;
  const validEnvelope = index === 0
    && item?.role === 'developer'
    && !Object.hasOwn(body ?? {}, 'tools')
    && Array.isArray(item?.tools);
  return {mode: 'responses_lite', tools: item?.tools, validEnvelope};
}

function catalogueMatches(body) {
  const {mode, tools, validEnvelope} = catalogueLocation(body);
  if (!validEnvelope || !Array.isArray(tools)) return false;
  const expected = mode === 'responses_lite' ? expectedResponsesLiteToolCatalogue() : FIXTURE_TOOL_CATALOGUE;
  return canonical(tools) === canonical(expected);
}

function safeToolCatalogue(body) {
  const {mode, tools, validEnvelope} = catalogueLocation(body);
  if (!Array.isArray(tools)) return {mode, present: false, count: 0, matchesExpected: false, validEnvelope, entries: []};
  const functions = mode === 'responses_lite'
    ? tools.flatMap(tool => tool?.type === 'namespace' && Array.isArray(tool.tools) ? tool.tools : [])
    : tools;
  return {
    mode,
    present: true,
    count: functions.length,
    matchesExpected: catalogueMatches(body),
    validEnvelope,
    entries: functions.slice(0, 16).map(tool => ({
      type: typeof tool?.type === 'string' ? tool.type : null,
      name: typeof tool?.name === 'string' ? tool.name : null,
      keys: Object.keys(tool ?? {}).sort(),
      parametersHash: tool?.parameters && typeof tool.parameters === 'object' ? digest(tool.parameters) : null,
      expectedParametersHash: FIXTURE_TOOL_CATALOGUE.find(item => item.name === tool?.name)?.parameters
        ? digest(FIXTURE_TOOL_CATALOGUE.find(item => item.name === tool.name).parameters)
        : null,
    })),
  };
}

function safeRequestShape(body) {
  return {
    topLevelKeys: Object.keys(body ?? {}).sort(),
    model: typeof body?.model === 'string' ? body.model : null,
    streaming: body?.stream === true,
    inputCount: Array.isArray(body?.input) ? body.input.length : 0,
    inputTypes: Array.isArray(body?.input) ? body.input.slice(0, 32).map(item => typeof item?.type === 'string' ? item.type : 'unknown') : [],
  };
}

function latestUserText(input) {
  if (!Array.isArray(input)) return '';
  const userMessages = input.filter(item => item?.type === 'message' && item?.role === 'user');
  const latest = userMessages.at(-1);
  if (!latest) return '';
  if (typeof latest.content === 'string') return latest.content;
  if (!Array.isArray(latest.content)) return '';
  return latest.content.map(item => typeof item?.text === 'string' ? item.text : '').join(' ');
}

function fixtureOutput(item) {
  let text = item?.output;
  if (Array.isArray(text)) text = text.map(part => part?.text ?? '').join(' ');
  if (typeof text !== 'string') throw new Error('The read-case tool output is not text.');
  const value = JSON.parse(text);
  if (!value || value.fictional !== true || typeof value.id !== 'string' || !value.lead || typeof value.lead.email !== 'string' || !Array.isArray(value.sourceIds)) {
    throw new Error('The read-case tool output is not the expected fictional fixture.');
  }
  return value;
}

function selectedCase(text) {
  const matches = Object.entries(CASE_BY_ID).filter(([, details]) => details.match.test(text));
  if (matches.length !== 1) throw new Error('The request does not identify exactly one supported fictional case.');
  return matches[0][0];
}

function proposalArguments(caseId, fixture) {
  const details = CASE_BY_ID[caseId];
  if (fixture.id !== caseId || fixture.lead.email !== details.recipient || fixture.sourceIds.length < 2) {
    throw new Error('The read fixture does not match the selected fictional case.');
  }
  const args = {
    caseId,
    recipient: fixture.lead.email,
    body: details.body,
    sourceIds: [...fixture.sourceIds],
  };
  if (caseId !== 'consultation') {
    args.subject = details.subject;
    return args;
  }
  const slot = fixture.slots?.find(item => item.available === true && item.start === '2026-10-13T10:00:00.000Z');
  if (!slot) throw new Error('The seeded fictional consultation slot is unavailable.');
  return {...args, start: slot.start, end: slot.end, timeZone: slot.timeZone, calendar: slot.calendar};
}

async function readBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body limit exceeded.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendError(response, status, code) {
  response.writeHead(status, {'content-type': 'application/json', connection: 'close'});
  response.end(JSON.stringify({error: {code}}));
}

/**
 * Starts a local deterministic Responses fixture. It only binds 127.0.0.1,
 * accepts `/v1/responses`, and rejects every tool catalogue except the exact
 * two direct Kitchen Front fixture tools.
 */
export async function createFixtureResponsesProvider() {
  const report = {requestCount: 0, verifiedCatalogues: 0, sequence: [], errors: [], catalogueObservations: [], requestShapes: []};
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      sendError(response, 404, 'FIXTURE_ROUTE_NOT_FOUND');
      return;
    }
    report.requestCount += 1;
    try {
      const body = await readBody(request);
      if (body?.model !== 'gpt-6-luna' || body?.stream !== true) {
        report.errors.push('MODEL_OR_STREAM_MISMATCH');
        sendError(response, 403, 'MODEL_OR_STREAM_MISMATCH');
        return;
      }
      const catalogue = safeToolCatalogue(body);
      report.catalogueObservations.push(catalogue);
      report.requestShapes.push(safeRequestShape(body));
      if (!catalogue.matchesExpected) {
        report.errors.push('TOOL_CATALOGUE_MISMATCH');
        sendError(response, 403, 'TOOL_CATALOGUE_MISMATCH');
        return;
      }
      report.verifiedCatalogues += 1;
      const caseId = selectedCase(latestUserText(body.input));
      const details = CASE_BY_ID[caseId];
      const input = Array.isArray(body.input) ? body.input : [];
      const latestUserIndex = input.findLastIndex(item => item?.type === 'message' && item?.role === 'user');
      if (latestUserIndex < 0) throw new Error('No current user message was supplied.');
      const turnOutputItems = input.slice(latestUserIndex + 1).filter(item => item?.type === 'function_call_output');
      const stage = turnOutputItems.length;
      let outputItem;
      let responseId;
      let beforeDone = [];
      if (stage === 0) {
        responseId = `fixture-${caseId}-read`;
        outputItem = {
          type: 'function_call', id: `${responseId}-item`, call_id: `${responseId}-call`,
          namespace: 'functions', name: 'get_demo_case', arguments: JSON.stringify({caseId}), status: 'completed',
        };
      } else if (stage === 1) {
        const fixture = fixtureOutput(turnOutputItems[0]);
        const argumentsValue = proposalArguments(caseId, fixture);
        responseId = `fixture-${caseId}-proposal`;
        outputItem = {
          type: 'function_call', id: `${responseId}-item`, call_id: `${responseId}-call`,
          namespace: 'functions', name: 'prepare_demo_proposal', arguments: JSON.stringify(argumentsValue), status: 'completed',
        };
      } else if (stage === 2) {
        responseId = `fixture-${caseId}-answer`;
        outputItem = {
          type: 'message', id: `${responseId}-item`, role: 'assistant',
          content: [{type: 'output_text', text: details.answer}],
          phase: 'final_answer',
        };
        beforeDone = [
          {type: 'response.output_item.added', item: {
            type: 'message', id: `${responseId}-item`, role: 'assistant', content: [], phase: 'final_answer',
          }},
          {type: 'response.output_text.delta', delta: details.answer},
        ];
      } else {
        throw new Error('The fixture turn exceeded its two-tool sequence.');
      }
      report.sequence.push({caseId, stage, outputType: outputItem.type, toolName: outputItem.name ?? null});
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      response.end(sse(responseEvents(responseId, outputItem, 100 + stage * 20, 12 + stage * 3, beforeDone)));
    } catch {
      report.errors.push('FIXTURE_REQUEST_REJECTED');
      sendError(response, 400, 'FIXTURE_REQUEST_REJECTED');
    }
  });
  await new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await new Promise(resolve => server.close(resolve));
    throw new Error('The fixture provider did not bind to IPv4 loopback.');
  }
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    report: () => structuredClone(report),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export const FIXTURE_CASE_IDS = Object.freeze(Object.keys(CASE_BY_ID));
export const FIXTURE_REQUESTS_ARE_MODEL_FREE = true;
export const FIXTURE_TOOL_NAMES = EXPECTED_TOOL_NAMES;
export const FIXTURE_CASE_REQUESTS = Object.freeze({
  quotation: 'Please chase the fictional quotation for Robin and prepare a follow-up for human review.',
  reply: 'Please reply to Alex’s fictional kitchen enquiry and leave the proposal for human review.',
  consultation: 'Please propose a fictional consultation follow-up to Casey using an available seeded slot.',
});
export const FIXTURE_TOOL_CATALOGUE = Object.freeze(DYNAMIC_TOOLS.map(tool => ({
  type: 'function', name: tool.name, parameters: schemaAsCodexSerializes(tool.inputSchema), description: tool.description, strict: false,
})));
export const FIXTURE_RESPONSES_LITE_TOOL_CATALOGUE = Object.freeze(expectedResponsesLiteToolCatalogue());
