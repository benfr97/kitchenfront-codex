import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {freshState, getCase, prepareProposal, decideProposal, createToolDispatcher, replayScenario, CALENDAR, TIME_ZONE} from '../lib/fixtures.mjs';
const context = () => ({requestId: randomUUID(), mode: 'offline_replay'});
const argsFor = (state, id) => {
  const fixture = getCase(state, id);
  return {caseId: id, recipient: fixture.lead.email, sourceIds: fixture.sourceIds, body: 'Hello, would you like to discuss the proposed next step?', ...(id === 'consultation' ? {start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T11:00:00.000Z', timeZone: TIME_ZONE, calendar: CALENDAR} : {subject: 'Your fictional kitchen enquiry'})};
};
test('same quotation sources preserve the missing total and attachment', () => {
  const fixture = getCase(freshState(), 'quotation');
  assert.match(fixture.correspondence[1].body, /DEMO-Q017/);
  assert.deepEqual(fixture.knownMissing, ['quotation total', 'quotation attachment']);
  assert.equal(fixture.lead.email, 'robin@example.org');
});
test('unobserved case, recipient substitution and invented source are rejected before staging', () => {
  const state = freshState(); const args = argsFor(state, 'reply');
  assert.throws(() => prepareProposal(state, args, new Set(), context()), {code: 'SOURCE_NOT_READ'});
  assert.throws(() => prepareProposal(state, {...args, recipient: 'other@example.org'}, new Set(['reply']), context()), {code: 'RECIPIENT_MISMATCH'});
  assert.throws(() => prepareProposal(state, {...args, sourceIds: ['invented']}, new Set(['reply']), context()), {code: 'SOURCE_MISMATCH'});
  assert.equal(state.proposals.length, 0);
});
test('prices and completed-action claims cannot be staged in this comparison', () => {
  const state = freshState(); const args = argsFor(state, 'quotation');
  for (const body of ['Your quotation is £35,000.', 'I have sent the quotation.', 'The attachment enclosed shows the total.']) {
    assert.throws(() => prepareProposal(state, {...args, body}, new Set(['quotation']), context()), {code: 'UNSUPPORTED_CLAIM'});
  }
});
test('proposal stays pending until the exact reviewed revision is approved; replay has no duplicate effect', async () => {
  const state = freshState(); const result = await replayScenario(state, 'reply', randomUUID(), () => {}); const proposal = result.proposals[0];
  assert.equal(proposal.status, 'pending');
  assert.throws(() => decideProposal(state, proposal.id, 'approve', 'wrong-revision'), {code: 'STALE_REVIEW'});
  const first = decideProposal(state, proposal.id, 'approve', proposal.revision);
  assert.equal(first.proposal.status, 'approved'); assert.match(first.proposal.result, /No email was sent/);
  assert.equal(decideProposal(state, proposal.id, 'approve', proposal.revision).replayed, true);
  assert.equal(state.activity.filter(item => item.kind === 'decision').length, 1);
  assert.throws(() => decideProposal(state, proposal.id, 'reject', proposal.revision), {code: 'DECISION_CONFLICT'});
});
test('rejecting a quotation proposal takes no simulated action', async () => {
  const state = freshState(); const {proposals: [proposal]} = await replayScenario(state, 'quotation', randomUUID(), () => {});
  const result = decideProposal(state, proposal.id, 'reject', proposal.revision);
  assert.equal(result.proposal.status, 'rejected'); assert.match(result.proposal.result, /No simulated action/);
  assert.equal(state.appointments.length, 1);
});
test('exact consultation slot and timezone are enforced, and approval rechecks a new conflict', () => {
  const state = freshState(); const args = argsFor(state, 'consultation');
  assert.throws(() => prepareProposal(state, {...args, timeZone: 'UTC'}, new Set(['consultation']), context()), {code: 'SLOT_CONFLICT'});
  assert.throws(() => prepareProposal(state, {...args, start: '2026-10-13T09:00:00.000Z', end: '2026-10-13T10:00:00.000Z'}, new Set(['consultation']), context()), {code: 'SLOT_CONFLICT'});
  const proposal = prepareProposal(state, args, new Set(['consultation']), context());
  state.appointments.push({start: args.start, end: args.end, calendar: CALENDAR});
  const result = decideProposal(state, proposal.id, 'approve', proposal.revision);
  assert.equal(result.proposal.status, 'conflict'); assert.equal(state.appointments.length, 2);
});
test('unknown fields, unknown tools and another scenario’s proposal are rejected', async () => {
  const state = freshState(); const dispatch = createToolDispatcher(state, randomUUID(), 'offline_replay');
  await assert.rejects(dispatch('exec_command', {cmd: 'pwd'}), {code: 'TOOL_NOT_ALLOWED'});
  await assert.rejects(dispatch('get_demo_case', {caseId: 'reply', account: 'real'}), {code: 'INVALID_ARGUMENTS'});
  const {proposals: [proposal]} = await replayScenario(state, 'reply', randomUUID(), () => {});
  assert.throws(() => decideProposal(freshState(), proposal.id, 'approve', proposal.revision), {code: 'PROPOSAL_NOT_FOUND'});
});
test('replays are explicit, observed tool events pair correctly, and no AI usage is invented', async () => {
  const state = freshState(); const events = []; const result = await replayScenario(state, 'consultation', randomUUID(), event => events.push(event));
  assert.equal(result.mode, 'offline_replay'); assert.equal(result.usage, null); assert.match(result.answer, /No AI model ran/);
  assert.deepEqual(events.map(item => item.type), ['tool.started', 'tool.completed', 'tool.started', 'tool.completed']);
  assert.equal(events[0].itemId, events[1].itemId); assert.equal(events[2].itemId, events[3].itemId);
});
