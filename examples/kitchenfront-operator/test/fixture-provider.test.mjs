import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixtureResponsesProvider,
  FIXTURE_CASE_IDS,
  FIXTURE_CASE_REQUESTS,
  FIXTURE_REQUESTS_ARE_MODEL_FREE,
  FIXTURE_RESPONSES_LITE_TOOL_CATALOGUE,
  FIXTURE_TOOL_CATALOGUE,
  FIXTURE_TOOL_NAMES,
} from '../lib/fixture-provider.mjs';
import {createToolDispatcher, freshState, getCase} from '../lib/fixtures.mjs';

function decodeSse(text) {
  return text.trim().split('\n\n').map(block => {
    const data = block.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data, 'each fixture SSE event has a JSON data line');
    return JSON.parse(data.slice('data: '.length));
  });
}

function requestBody(input) {
  return {model: 'gpt-6-luna', stream: true, input, tools: structuredClone(FIXTURE_TOOL_CATALOGUE)};
}

function responsesLiteRequestBody(input) {
  return {
    model: 'gpt-6-luna',
    stream: true,
    input: [
      {type: 'additional_tools', id: 'at_fixture', role: 'developer', tools: structuredClone(FIXTURE_RESPONSES_LITE_TOOL_CATALOGUE)},
      ...input,
    ],
  };
}

async function request(provider, input) {
  const response = await fetch(`${provider.baseUrl}/responses`, {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'text/event-stream'},
    body: JSON.stringify(requestBody(input)),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  return decodeSse(await response.text());
}

test('loopback fixture emits the bounded read, proposal, answer Responses sequence for all three cases', async t => {
  assert.equal(FIXTURE_REQUESTS_ARE_MODEL_FREE, true);
  assert.deepEqual(FIXTURE_TOOL_NAMES, ['get_demo_case', 'prepare_demo_proposal']);
  const provider = await createFixtureResponsesProvider();
  t.after(() => provider.close());
  assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  for (const caseId of FIXTURE_CASE_IDS) {
    const state = freshState();
    const dispatch = createToolDispatcher(state, `fixture-request-${caseId}`, 'protocol_fixture');
    const input = [{type: 'message', role: 'user', content: [{type: 'input_text', text: FIXTURE_CASE_REQUESTS[caseId]}]}];

    const readEvents = await request(provider, input);
    const readCall = readEvents.find(event => event.item?.type === 'function_call')?.item;
    assert.equal(readCall?.name, 'get_demo_case');
    assert.equal(readCall?.namespace, 'functions');
    assert.deepEqual(JSON.parse(readCall.arguments), {caseId});
    const caseData = getCase(state, caseId);
    const readResult = await dispatch('get_demo_case', {caseId}, readCall.call_id);
    input.push(
      {type: 'function_call', call_id: readCall.call_id, name: readCall.name, arguments: readCall.arguments},
      {type: 'function_call_output', call_id: readCall.call_id, output: JSON.stringify(readResult)},
    );

    const proposalEvents = await request(provider, input);
    const proposalCall = proposalEvents.find(event => event.item?.type === 'function_call')?.item;
    assert.equal(proposalCall?.name, 'prepare_demo_proposal');
    assert.equal(proposalCall?.namespace, 'functions');
    const proposalArguments = JSON.parse(proposalCall.arguments);
    assert.equal(proposalArguments.caseId, caseId);
    assert.equal(proposalArguments.recipient, caseData.lead.email);
    assert.deepEqual(proposalArguments.sourceIds, caseData.sourceIds);
    const proposalResult = await dispatch('prepare_demo_proposal', proposalArguments, proposalCall.call_id);
    assert.equal(proposalResult.status, 'pending');
    assert.equal(state.proposals.length, 1);
    input.push(
      {type: 'function_call', call_id: proposalCall.call_id, name: proposalCall.name, arguments: proposalCall.arguments},
      {type: 'function_call_output', call_id: proposalCall.call_id, output: JSON.stringify(proposalResult)},
    );

    const answerEvents = await request(provider, input);
    const message = answerEvents.find(event => event.type === 'response.output_item.done' && event.item?.type === 'message')?.item;
    assert.equal(message?.content?.[0]?.type, 'output_text');
    assert.match(message.content[0].text, /ready for review/);
    assert.doesNotMatch(message.content[0].text, /(?<!no )email was sent|(?<!no real )appointment was booked/i);
    assert.equal(answerEvents.find(event => event.type === 'response.output_item.added')?.item?.phase, 'final_answer');
    assert.equal(answerEvents.find(event => event.type === 'response.output_text.delta')?.delta, message.content[0].text);
    const completed = answerEvents.find(event => event.type === 'response.completed');
    assert.equal(completed?.response?.usage?.total_tokens, 158);
  }

  const report = provider.report();
  assert.equal(report.requestCount, 9);
  assert.equal(report.verifiedCatalogues, 9);
  assert.deepEqual(report.errors, []);
  assert.ok(report.catalogueObservations.every(item => item.matchesExpected));
  assert.deepEqual(report.sequence.map(item => [item.caseId, item.stage]), FIXTURE_CASE_IDS.flatMap(caseId => [[caseId, 0], [caseId, 1], [caseId, 2]]));
  assert.ok(report.sequence.filter(item => item.outputType === 'function_call').every(item => ['get_demo_case', 'prepare_demo_proposal'].includes(item.toolName)));
});

test('loopback fixture rejects an expanded tool catalogue and non-Responses routes', async t => {
  const provider = await createFixtureResponsesProvider();
  t.after(() => provider.close());
  const body = requestBody([{type: 'message', role: 'user', content: [{type: 'input_text', text: FIXTURE_CASE_REQUESTS.reply}]}]);
  body.tools.push({type: 'function', name: 'exec_command', parameters: {type: 'object'}});
  const expanded = await fetch(`${provider.baseUrl}/responses`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  assert.equal(expanded.status, 403);
  assert.equal((await expanded.json()).error.code, 'TOOL_CATALOGUE_MISMATCH');
  const alteredSchemaBody = requestBody([{type: 'message', role: 'user', content: [{type: 'input_text', text: FIXTURE_CASE_REQUESTS.reply}]}]);
  alteredSchemaBody.tools[1].parameters.additionalProperties = true;
  const alteredSchema = await fetch(`${provider.baseUrl}/responses`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(alteredSchemaBody),
  });
  assert.equal(alteredSchema.status, 403);
  assert.equal((await alteredSchema.json()).error.code, 'TOOL_CATALOGUE_MISMATCH');
  const otherRoute = await fetch(`${provider.baseUrl}/models`, {method: 'GET'});
  assert.equal(otherRoute.status, 404);
  const report = provider.report();
  assert.deepEqual(report.errors, ['TOOL_CATALOGUE_MISMATCH', 'TOOL_CATALOGUE_MISMATCH']);
  assert.equal(report.catalogueObservations.length, 2);
  assert.equal(report.catalogueObservations[1].matchesExpected, false);
  assert.equal(report.catalogueObservations[1].entries[1].parametersHash === report.catalogueObservations[1].entries[1].expectedParametersHash, false);
});

test('Responses Lite catalogue is exact and an altered nested schema is rejected', async t => {
  const provider = await createFixtureResponsesProvider();
  t.after(() => provider.close());
  const userInput = [{type: 'message', role: 'user', content: [{type: 'input_text', text: FIXTURE_CASE_REQUESTS.reply}]}];
  const valid = responsesLiteRequestBody(userInput);
  const validResponse = await fetch(`${provider.baseUrl}/responses`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(valid),
  });
  assert.equal(validResponse.status, 200);
  const validEvents = decodeSse(await validResponse.text());
  const call = validEvents.find(event => event.item?.type === 'function_call')?.item;
  assert.equal(call?.name, 'get_demo_case');
  assert.equal(call?.namespace, 'functions');

  const alteredSchemaBody = responsesLiteRequestBody(userInput);
  alteredSchemaBody.input[0].tools[0].tools[1].parameters.additionalProperties = true;
  const alteredSchema = await fetch(`${provider.baseUrl}/responses`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(alteredSchemaBody),
  });
  assert.equal(alteredSchema.status, 403);
  assert.equal((await alteredSchema.json()).error.code, 'TOOL_CATALOGUE_MISMATCH');
  const report = provider.report();
  assert.deepEqual(report.errors, ['TOOL_CATALOGUE_MISMATCH']);
  assert.equal(report.catalogueObservations.length, 2);
  assert.equal(report.catalogueObservations[0].mode, 'responses_lite');
  assert.equal(report.catalogueObservations[0].count, 2);
  assert.equal(report.catalogueObservations[0].matchesExpected, true);
  assert.equal(report.catalogueObservations[1].matchesExpected, false);
  assert.notEqual(report.catalogueObservations[1].entries[1].parametersHash, report.catalogueObservations[1].entries[1].expectedParametersHash);
});
