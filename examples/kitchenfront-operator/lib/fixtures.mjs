import {createHash, randomUUID} from 'node:crypto';

export const SCENARIO_DATE = '2026-10-13';
export const CALENDAR = 'demo-consultations';
export const TIME_ZONE = 'Europe/London';
export const MODE_REPLAY = 'offline_replay';
const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class DemoError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const incoming = (id, body, createdAt) => ({id, direction: 'incoming', subject: 'Fictional kitchen enquiry', body, createdAt, simulated: true});
const baseCases = {
  quotation: {
    id: 'quotation', label: 'Chase Robin’s quotation',
    lead: {id: 'demo-lead-stale', name: 'Robin Sample', email: 'robin@example.org', budget: '£35,000–£45,000 (fictional customer estimate)', timescale: 'Spring 2027 (fictional preference)', qualified: true},
    correspondence: [incoming('demo-message-demo-lead-stale', 'We are considering a Shaker kitchen for next spring. Please prepare a quotation following our fictional design discussion.', '2026-10-05T09:00:00.000Z'),
      {id: 'demo-message-quotation-issued', direction: 'outgoing', subject: 'Your fictional quotation DEMO-Q017', body: 'Hello Robin. Following our fictional design discussion, here is quotation DEMO-Q017 for your Shaker kitchen design and cabinetry. This sample correspondence records a quotation awaiting your reply; no quotation total or attachment is provided. Let us know if you would like to discuss the proposed scope.', createdAt: '2026-10-05T10:00:00.000Z', simulated: true}],
    knownMissing: ['quotation total', 'quotation attachment'],
  },
  reply: {
    id: 'reply', label: 'Reply to Alex’s enquiry',
    lead: {id: 'demo-lead-fresh', name: 'Alex Example', email: 'alex@example.com', budget: '', timescale: '', qualified: false},
    correspondence: [incoming('demo-message-demo-lead-fresh', 'We are planning a kitchen with an island and would like to understand the next steps.', '2026-10-13T07:45:00.000Z')],
    knownMissing: ['customer budget', 'customer timing'],
  },
  consultation: {
    id: 'consultation', label: 'Arrange Casey’s consultation',
    lead: {id: 'demo-lead-consultation', name: 'Casey Demo', email: 'casey@example.net', budget: '£40,000–£50,000 (fictional customer estimate)', timescale: 'Early 2027 (fictional preference)', qualified: true},
    correspondence: [incoming('demo-message-demo-lead-consultation', 'Could we discuss our kitchen plans on Tuesday morning? This is a fictional consultation request.', '2026-10-12T12:00:00.000Z')],
    knownMissing: [],
  },
};
export const CASE_IDS = Object.freeze(Object.keys(baseCases));
const allSlots = ['08', '09', '10', '13'].map(hour => ({start: `${SCENARIO_DATE}T${hour}:00:00.000Z`, end: `${SCENARIO_DATE}T${String(Number(hour) + 1).padStart(2, '0')}:00:00.000Z`, timeZone: TIME_ZONE, calendar: CALENDAR}));
export function freshState() {
  return {generation: randomUUID(), messages: [], proposals: [], activity: [], requests: {}, engineThreadId: null,
    appointments: [{id: 'demo-appointment-existing', start: `${SCENARIO_DATE}T09:00:00.000Z`, end: `${SCENARIO_DATE}T10:00:00.000Z`, timeZone: TIME_ZONE, calendar: CALENDAR, simulated: true}]};
}
export function getCase(state, caseId) {
  if (!CASE_IDS.includes(caseId)) throw new DemoError('UNKNOWN_CASE', 'Choose one of the three fictional cases.');
  const value = copy(baseCases[caseId]);
  return {...value, fictional: true, scenarioDate: SCENARIO_DATE, timeZone: TIME_ZONE,
    sourceIds: [value.lead.id, ...value.correspondence.map(item => item.id)],
    ...(caseId === 'consultation' ? {calendar: CALENDAR, slots: allSlots.map(slot => ({...slot, available: !overlapsAny(slot, state.appointments)}))} : {}),
    businessFacts: {services: 'Not supplied for this controlled comparison.', pricing: 'Unknown.', installationTiming: 'Unknown.'}};
}
const overlapsAny = (slot, appointments) => appointments.some(item => item.calendar === slot.calendar && slot.start < item.end && slot.end > item.start);
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new DemoError('INVALID_ARGUMENTS', 'The tool arguments do not match this demo tool.');
}
function text(value, field, max = 1800) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DemoError('INVALID_ARGUMENTS', `Provide a bounded ${field}.`);
  return value.trim();
}
export function prepareProposal(state, args, observedCases, {requestId, mode}) {
  exactObject(args, ['caseId', 'recipient', 'subject', 'body', 'start', 'end', 'timeZone', 'calendar', 'sourceIds']);
  const fixture = getCase(state, args.caseId);
  if (!observedCases.has(args.caseId)) throw new DemoError('SOURCE_NOT_READ', 'Read this fictional case before preparing its proposal.');
  if (args.recipient !== fixture.lead.email) throw new DemoError('RECIPIENT_MISMATCH', 'The recipient must match the retrieved fictional customer.');
  if (!Array.isArray(args.sourceIds) || !args.sourceIds.length || new Set(args.sourceIds).size !== args.sourceIds.length || args.sourceIds.some(id => !fixture.sourceIds.includes(id))) throw new DemoError('SOURCE_MISMATCH', 'Use only the source IDs returned for this case.');
  if (!args.sourceIds.includes(fixture.lead.id)) throw new DemoError('SOURCE_MISSING', 'Include the retrieved lead source.');
  const body = text(args.body, 'message');
  if (/[£$€]|\b(?:guarantee|attached|attachment enclosed|I have sent|I’ve sent|we have booked)\b/i.test(body)) throw new DemoError('UNSUPPORTED_CLAIM', 'This comparison must not add prices, attachments, promises or completed actions.');
  const kind = args.caseId === 'consultation' ? 'consultation' : 'reply';
  let fields = {caseId: args.caseId, kind, title: fixture.label, recipient: args.recipient, body, sourceIds: [...args.sourceIds]};
  if (kind === 'consultation') {
    const slot = allSlots.find(slot => slot.start === args.start && slot.end === args.end && slot.timeZone === args.timeZone && slot.calendar === args.calendar);
    if (!slot || overlapsAny(slot, state.appointments)) throw new DemoError('SLOT_CONFLICT', 'That exact seeded slot is unavailable. No appointment was created.', 409);
    fields = {...fields, ...slot};
  } else {
    if (['start', 'end', 'timeZone', 'calendar'].some(key => args[key] != null)) throw new DemoError('INVALID_ARGUMENTS', 'A reply cannot contain a calendar action.');
    fields.subject = text(args.subject, 'subject', 160);
  }
  const revision = digest({generation: state.generation, fields});
  const identical = state.proposals.find(item => item.requestId === requestId && item.revision === revision);
  if (identical) return copy(identical);
  if (state.proposals.some(item => item.caseId === args.caseId && item.status === 'pending')) throw new DemoError('PENDING_REVIEW', 'Review or reject the existing proposal for this case first.', 409);
  if (state.proposals.length >= 12) throw new DemoError('CAPACITY', 'Reset the fictional scenario before preparing more proposals.', 409);
  const proposal = {...fields, id: randomUUID(), revision, generation: state.generation, requestId, mode, status: 'pending', createdAt: new Date().toISOString(), simulated: true};
  state.proposals.push(proposal);
  return copy(proposal);
}
export function decideProposal(state, id, decision, revision) {
  const proposal = state.proposals.find(item => item.id === id);
  if (!proposal || proposal.generation !== state.generation) throw new DemoError('PROPOSAL_NOT_FOUND', 'This proposal belongs to a different or expired scenario.', 404);
  if (revision !== proposal.revision || !['approve', 'reject'].includes(decision)) throw new DemoError('STALE_REVIEW', 'Review the exact current proposal before deciding.', 409);
  if (proposal.status !== 'pending') {
    if ((decision === 'approve' && proposal.status === 'approved') || (decision === 'reject' && proposal.status === 'rejected')) return {proposal: copy(proposal), replayed: true};
    throw new DemoError('DECISION_CONFLICT', 'This proposal already has a different decision.', 409);
  }
  if (decision === 'reject') {
    proposal.status = 'rejected'; proposal.result = 'Rejected. No simulated action was taken.';
  } else if (proposal.kind === 'consultation' && overlapsAny(proposal, state.appointments)) {
    proposal.status = 'conflict'; proposal.result = 'The slot became occupied. No appointment was created.';
  } else {
    proposal.status = 'approved';
    proposal.result = proposal.kind === 'reply' ? 'Fictional reply saved in this scenario. No email was sent.' : 'Fictional consultation saved in this scenario. No real calendar was changed.';
    if (proposal.kind === 'consultation') state.appointments.push({id: randomUUID(), start: proposal.start, end: proposal.end, timeZone: proposal.timeZone, calendar: proposal.calendar, simulated: true});
  }
  state.activity.push({id: randomUUID(), kind: 'decision', label: proposal.result, status: proposal.status, createdAt: new Date().toISOString(), mode: proposal.mode, requestId: proposal.requestId});
  return {proposal: copy(proposal), replayed: false};
}
const caseSchema = {type: 'string', enum: CASE_IDS};
export const DYNAMIC_TOOLS = Object.freeze([
  {type: 'function', name: 'get_demo_case', description: 'Read one fictional quotation, enquiry or consultation case, its source IDs and exact seeded availability. No real business system is connected.', inputSchema: {type: 'object', properties: {caseId: caseSchema}, required: ['caseId'], additionalProperties: false}},
  {type: 'function', name: 'prepare_demo_proposal', description: 'Stage a proposal for explicit human review after reading its fictional case. This never sends, approves or books anything.', inputSchema: {type: 'object', properties: {caseId: caseSchema, recipient: {type: 'string'}, subject: {type: 'string'}, body: {type: 'string', maxLength: 1800}, start: {type: 'string'}, end: {type: 'string'}, timeZone: {type: 'string'}, calendar: {type: 'string'}, sourceIds: {type: 'array', items: {type: 'string'}, minItems: 1}}, required: ['caseId', 'recipient', 'body', 'sourceIds'], additionalProperties: false}},
]);
export function createToolDispatcher(state, requestId, mode, emit = () => {}) {
  const observedCases = new Set(); let calls = 0;
  return async (name, args, itemId = randomUUID()) => {
    if (++calls > 12) throw new DemoError('TOOL_LIMIT', 'This request reached its bounded tool limit.');
    const tool = DYNAMIC_TOOLS.find(item => item.name === name);
    if (!tool) throw new DemoError('TOOL_NOT_ALLOWED', 'That tool is not available in this prototype.', 403);
    const label = name === 'get_demo_case' ? `Read ${baseCases[args?.caseId]?.label ?? 'fictional case'}` : 'Prepare proposal for review';
    emit({type: 'tool.started', itemId, name, label});
    try {
      let result;
      if (name === 'get_demo_case') { exactObject(args, ['caseId']); result = getCase(state, args.caseId); observedCases.add(args.caseId); }
      else result = prepareProposal(state, args, observedCases, {requestId, mode});
      state.activity.push({id: itemId, kind: 'tool', label, status: 'completed', createdAt: new Date().toISOString(), mode, requestId});
      emit({type: 'tool.completed', itemId, name, label, success: true}); return result;
    } catch (error) { emit({type: 'tool.completed', itemId, name, label, success: false}); throw error; }
  };
}
export async function replayScenario(state, caseId, requestId, emit) {
  const run = createToolDispatcher(state, requestId, MODE_REPLAY, emit);
  const fixture = await run('get_demo_case', {caseId});
  const body = caseId === 'quotation' ? 'Hello Robin, would you like to discuss the proposed scope of quotation DEMO-Q017 or any questions you have about it?' : caseId === 'reply' ? 'Hello Alex, thank you for sharing your plans for a kitchen with an island. What budget and timing do you have in mind?' : 'Hello Casey, would you like the available fictional consultation slot shown below?';
  let fields;
  if (caseId === 'consultation') {
    const slot = fixture.slots.find(slot => slot.available && slot.start.includes('T10:00'));
    if (!slot) throw new DemoError('SLOT_CONFLICT', 'The seeded consultation slot is occupied.', 409);
    const {available, ...exactSlot} = slot;
    fields = exactSlot;
  } else fields = {subject: caseId === 'quotation' ? 'Your quotation DEMO-Q017' : 'Your kitchen enquiry'};
  const proposal = await run('prepare_demo_proposal', {caseId, recipient: fixture.lead.email, body, sourceIds: fixture.sourceIds, ...fields});
  return {answer: 'Offline replay: the fictional records were read and a proposal is ready for review. No AI model ran.', proposals: [proposal], mode: MODE_REPLAY, usage: null};
}
