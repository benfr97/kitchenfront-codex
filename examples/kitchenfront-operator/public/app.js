const TASKS = [
  {
    id: 'quotation',
    person: 'Robin',
    kind: 'Quotation to chase',
    title: "Robin's quotation",
    description: 'A fictional quotation follow-up to review.',
    prompt: 'What should I follow up with Robin about the quotation?'
  },
  {
    id: 'reply',
    person: 'Alex',
    kind: 'Customer to reply to',
    title: "Alex's enquiry",
    description: 'A fictional customer enquiry to answer.',
    prompt: "Help me reply to Alex's enquiry."
  },
  {
    id: 'consultation',
    person: 'Casey',
    kind: 'Consultation to arrange',
    title: "Casey's consultation",
    description: 'A fictional consultation request to review.',
    prompt: "What should I propose for Casey's consultation?"
  }
];

const state = {
  session: null,
  selectedTask: 'quotation',
  initialSessionLoaded: false,
  hasUserSelectedTask: false,
  serverMessages: [],
  transientMessages: [],
  proposals: [],
  activity: [],
  activeRun: null,
  runSerial: 0,
  busyDecisions: new Set(),
  lockedProposals: new Set(),
  proposalErrors: new Map(),
  globalError: '',
  loading: true,
  scrollToLatest: true,
  resetBusy: false,
  sessionLoadFailed: false
};

const elements = {
  engineStatus: document.querySelector('#engine-status'),
  engineDetail: document.querySelector('#engine-detail'),
  resetOpen: document.querySelector('#reset-open'),
  resetDialog: document.querySelector('#reset-dialog'),
  resetCancel: document.querySelector('#reset-cancel'),
  resetConfirm: document.querySelector('#reset-confirm'),
  taskList: document.querySelector('#task-list'),
  replayList: document.querySelector('#replay-list'),
  taskTitle: document.querySelector('#task-title'),
  taskDescription: document.querySelector('#task-description'),
  modeLabel: document.querySelector('#mode-label'),
  thread: document.querySelector('#conversation-thread'),
  activityList: document.querySelector('#activity-list'),
  replyForm: document.querySelector('#reply-form'),
  replyInput: document.querySelector('#reply-input'),
  composerNote: document.querySelector('#composer-note'),
  replyButton: document.querySelector('#reply-button'),
  stopButton: document.querySelector('#stop-button'),
  globalError: document.querySelector('#global-error')
};

const TERMINAL_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.interrupted']);

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return '[Result could not be displayed]'; }
  }
  return '';
}

function firstText(record, keys) {
  if (!record || typeof record !== 'object') return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function currentTask() {
  return TASKS.find((task) => task.id === state.selectedTask) || TASKS[0];
}

function showGlobalError(message) {
  state.globalError = message;
  renderGlobalError();
}

function clearGlobalError() {
  state.globalError = '';
  renderGlobalError();
}

function renderGlobalError() {
  elements.globalError.replaceChildren();
  if (state.globalError) {
    elements.globalError.append(element('span', 'global-error-copy', state.globalError));
    if (state.sessionLoadFailed && !state.loading) {
      const retry = element('button', 'secondary-button', 'Retry session load');
      retry.type = 'button';
      retry.addEventListener('click', () => void retrySessionLoad());
      elements.globalError.append(retry);
    }
  }
  elements.globalError.hidden = !state.globalError;
}

async function retrySessionLoad() {
  state.loading = true;
  clearGlobalError();
  render();
  try { await loadSession(); }
  catch (error) {
    state.loading = false;
    state.sessionLoadFailed = true;
    showGlobalError(error instanceof Error ? error.message : 'The fictional session could not be opened.');
    render();
  }
}

function apiErrorMessage(payload, fallback) {
  if (payload && typeof payload === 'object') {
    const message = payload.message || payload.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (message && typeof message === 'object' && typeof message.message === 'string') return message.message;
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return fallback;
}

async function readResponse(response, fallback) {
  let payload;
  const body = await response.text();
  if (body) {
    try { payload = JSON.parse(body); } catch { payload = body; }
  }
  if (!response.ok) {
    const error = new Error(apiErrorMessage(payload, `${fallback} (HTTP ${response.status})`));
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function csrfHeaders() {
  const token = state.session && typeof state.session.csrfToken === 'string' ? state.session.csrfToken : '';
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
}

async function postJson(path, body, fallback) {
  const response = await fetch(path, {
    method: 'POST',
    headers: csrfHeaders(),
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify(body)
  });
  return readResponse(response, fallback);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function setSession(session) {
  state.session = session && typeof session === 'object' ? session : {};
  state.serverMessages = arrayValue(state.session.messages);
  state.proposals = arrayValue(state.session.proposals);
  state.activity = arrayValue(state.session.activity);
  if (!state.initialSessionLoaded) {
    state.initialSessionLoaded = true;
    if (!state.hasUserSelectedTask) {
      const latestProposal = state.proposals.at(-1);
      const inferredTask = latestProposal && TASKS.find((task) => task.id === latestProposal.caseId);
      if (inferredTask) {
        state.selectedTask = inferredTask.id;
        elements.replyInput.value = inferredTask.prompt;
      }
    }
  }
  state.loading = false;
  for (const proposalId of state.lockedProposals) {
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (proposal && proposal.status !== 'pending') {
      state.lockedProposals.delete(proposalId);
      state.proposalErrors.delete(proposalId);
    }
  }
  restorePendingRequest();
  render();
}

function restorePendingRequest() {
  if (state.activeRun) return;
  const activities = state.activity.filter((item) => item && typeof item === 'object' && firstText(item, ['kind', 'type']) === 'turn' && firstText(item, ['requestId', 'request_id']));
  const latest = activities.at(-1);
  if (!latest) return;
  const requestId = firstText(latest, ['requestId', 'request_id']);
  const status = firstText(latest, ['status']).toLowerCase();
  const terminalStatuses = new Set(['completed', 'complete', 'succeeded', 'failed', 'interrupted']);
  const savedAnswer = state.serverMessages.some((message) => firstText(message, ['requestId', 'request_id']) === requestId && roleFor(message) === 'assistant');
  if (terminalStatuses.has(status) || savedAnswer || !['started', 'pending', 'running', 'stop_requested', 'stopping'].includes(status)) return;
  const replay = latest.mode === 'offline_replay';
  state.runSerial += 1;
  state.activeRun = {
    serial: state.runSerial,
    requestId,
    kind: replay ? 'replay' : 'turn',
    replay,
    taskId: state.selectedTask,
    mode: replay ? 'offline_replay' : '',
    turnId: '',
    started: true,
    terminal: false,
    finalState: '',
    answerText: '',
    error: replay ? 'A previous offline replay has no final event in this page. Check the saved session.' : 'A previous request has no final event in this page. Check the saved session or request a stop.',
    unknown: true,
    stopRequested: status === 'stop_requested' || status === 'stopping',
    stopSending: false,
    activity: [],
    seenToolEvents: new Set(),
    seenTerminal: new Set()
  };
}

async function loadSession({ keepTransient = false } = {}) {
  const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  const session = await readResponse(response, 'The fictional session could not be loaded.');
  if (!session || typeof session !== 'object') throw new Error('The session response did not contain a valid object.');
  state.sessionLoadFailed = false;
  setSession(session);
  if (!keepTransient) state.transientMessages = [];
  render();
  return session;
}

function addTransientMessage(message) {
  state.transientMessages.push(message);
  renderThread();
}

function roleFor(record) {
  const role = firstText(record, ['role', 'speaker', 'direction', 'type']).toLowerCase();
  if (['user', 'human', 'customer', 'outgoing', 'you'].includes(role)) return 'user';
  if (['assistant', 'ai', 'operator', 'bot', 'system'].includes(role)) return 'assistant';
  return 'assistant';
}

function textForMessage(record) {
  return firstText(record, ['text', 'content', 'body', 'message', 'answer']);
}

function timestampFor(record) {
  return firstText(record, ['timestamp', 'createdAt', 'created_at', 'time']);
}

function displayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }).format(date);
}

function renderTaskList() {
  if (elements.taskList.children.length === TASKS.length) {
    for (const button of elements.taskList.querySelectorAll('[data-task]')) {
      button.setAttribute('aria-current', String(button.dataset.task === state.selectedTask));
    }
    return;
  }
  elements.taskList.replaceChildren();
  for (const task of TASKS) {
    const button = element('button', 'task-button');
    button.type = 'button';
    button.dataset.task = task.id;
    button.setAttribute('aria-current', String(state.selectedTask === task.id));
    button.append(element('span', 'task-person', task.person));
    button.append(element('span', 'task-kind', task.kind));
    button.addEventListener('click', () => selectTask(task.id));
    elements.taskList.append(button);
  }
}

function renderReplays() {
  if (elements.replayList.children.length === TASKS.length) {
    for (const button of elements.replayList.querySelectorAll('button')) {
      button.disabled = !state.session || Boolean(state.activeRun) || state.loading;
    }
    return;
  }
  elements.replayList.replaceChildren();
  for (const task of TASKS) {
    const button = element('button', 'replay-button');
    button.type = 'button';
    button.disabled = !state.session || Boolean(state.activeRun) || state.loading;
    button.append(element('span', '', `Play ${task.person} example`));
    button.append(element('small', '', 'Offline replay, not an AI answer'));
    button.addEventListener('click', () => startReplay(task.id));
    elements.replayList.append(button);
  }
}

function selectTask(id) {
  if (state.activeRun) return;
  const oldTask = currentTask();
  const newTask = TASKS.find((task) => task.id === id);
  if (!newTask) return;
  state.hasUserSelectedTask = true;
  if (newTask.id === oldTask.id) return;
  const input = elements.replyInput;
  const draft = input.value.trim();
  if (!draft || draft === oldTask.prompt) input.value = newTask.prompt;
  state.selectedTask = newTask.id;
  renderHeader();
  renderTaskList();
  updateComposer();
}

function renderHeader() {
  const task = currentTask();
  elements.taskTitle.textContent = task.title;
  elements.taskDescription.textContent = task.description;
  elements.replyInput.placeholder = `Ask about ${task.person}'s ${task.id === 'quotation' ? 'quotation' : task.id === 'reply' ? 'enquiry' : 'consultation'}…`;
  const session = state.session || {};
  const engine = session.engine && typeof session.engine === 'object' ? session.engine : {};
  const engineName = [engine.name, engine.version].filter((part) => typeof part === 'string' && part).join(' ');
  const engineStatus = typeof engine.status === 'string' && engine.status.trim() ? engine.status.trim() : '';
  const engineStatusLabel = ({ not_verified: 'Engine not verified', protocol_checked: 'Protocol checked', ready: 'Engine ready' })[engineStatus] || engineStatus;
  const liveEnabled = session.liveEnabled === true;
  elements.engineStatus.textContent = liveEnabled ? 'Inference available' : 'Inference disabled';
  elements.engineDetail.textContent = `${engineName || 'Engine'} · ${engineStatusLabel || 'Status unknown'}`;
  const clock = document.querySelector('#scenario-clock');
  const dateContext = session.dateContext;
  const caseContext = dateContext?.cases?.[task.id];
  if (caseContext) {
    const londonDate = value => new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London'}).format(new Date(value));
    elements.taskDescription.textContent = task.id === 'quotation'
      ? `Fictional quotation awaiting a reply for ${caseContext.quoteAgeDays} days. Total and attachment are not supplied.`
      : task.id === 'reply'
        ? `Fictional enquiry received ${londonDate(caseContext.latestMessageAt)}. Budget and timing are unknown.`
        : `Fictional request for ${londonDate(caseContext.requestedStart)}. Check the diary before proposing a time.`;
  }
  clock.textContent = dateContext?.pinnedAt
    ? `Scenario pinned to ${new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London'}).format(new Date(dateContext.pinnedAt))} · London${dateContext.status === 'horizon_exhausted' ? ' · dataset expired' : ''}`
    : 'Historical protocol fixture · 13 Oct 2026';
  const blocker = typeof session.liveBlocker === 'string' ? session.liveBlocker.trim() : '';
  elements.engineStatus.title = blocker || (engineName ? `${engineName}${engineStatusLabel ? `, ${engineStatusLabel}` : ''}` : '');
  elements.modeLabel.textContent = state.activeRun?.mode === 'offline_replay'
    ? 'OFFLINE REPLAY'
    : liveEnabled ? 'Live inference available' : 'Inference disabled';
  elements.modeLabel.dataset.mode = state.activeRun?.mode || '';
}

function normalizeMessage(record) {
  if (!record || typeof record !== 'object') return null;
  const text = textForMessage(record);
  if (!text) return null;
  return {
    text,
    role: roleFor(record),
    timestamp: timestampFor(record),
    mode: firstText(record, ['mode']),
    label: firstText(record, ['label']),
    partial: record.partial === true
  };
}

function renderMessage(message) {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;
  const article = element('article', `message message--${normalized.role}`);
  const meta = element('div', 'message-meta');
  const related = state.proposals.find((proposal) => proposal.requestId === message.requestId);
  const person = TASKS.find((task) => task.id === related?.caseId)?.person;
  const speaker = normalized.role === 'user' ? 'You' : 'Operator';
  meta.append(element('strong', '', person ? `${speaker} · ${person}` : speaker));
  if (normalized.mode === 'offline_replay') {
    const tag = element('span', 'message-tag', 'OFFLINE REPLAY');
    tag.dataset.mode = 'offline_replay';
    meta.append(tag);
  } else if (normalized.mode) {
    meta.append(element('span', 'message-tag', normalized.mode === 'live_ai' ? 'AI RESPONSE' : normalized.mode.toUpperCase()));
  }
  if (normalized.partial) meta.append(element('span', 'message-tag', 'STREAMING, NOT COMPLETE'));
  const time = displayTime(normalized.timestamp);
  if (time) {
    const timeNode = element('time', '', time);
    timeNode.dateTime = normalized.timestamp;
    meta.append(timeNode);
  }
  const content = element('div', 'message-content', normalized.text);
  article.append(meta, content);
  return article;
}

function dedupedMessages() {
  const merged = [...state.serverMessages, ...state.transientMessages];
  const seen = new Set();
  const result = [];
  for (const message of merged) {
    const normalized = normalizeMessage(message);
    if (!normalized) continue;
    const explicitId = firstText(message, ['id', 'messageId', 'message_id']);
    const key = explicitId || `${normalized.role}|${normalized.mode}|${normalized.text}|${normalized.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
}

function renderThread() {
  const activeElement = document.activeElement;
  const focusKey = elements.thread.contains(activeElement) && activeElement instanceof HTMLElement ? activeElement.dataset.focusKey : '';
  const wasAtBottom = elements.thread.scrollHeight - elements.thread.scrollTop - elements.thread.clientHeight < 48;
  elements.thread.replaceChildren();
  if (state.loading) {
    elements.thread.append(element('p', 'loading-copy', 'Loading saved conversation…'));
    elements.thread.setAttribute('aria-busy', 'true');
    return;
  }
  const messages = dedupedMessages();
  const shownProposals = new Set();
  for (const [index, message] of messages.entries()) {
    const node = renderMessage(message);
    if (node) elements.thread.append(node);
    const requestId = message.requestId;
    if (requestId && !messages.slice(index + 1).some((later) => later.requestId === requestId)) {
      for (const proposal of state.proposals.filter((item) => item.requestId === requestId)) {
        elements.thread.append(renderProposal(proposal)); shownProposals.add(proposal.id);
      }
    }
  }
  for (const proposal of state.proposals) if (!shownProposals.has(proposal.id)) elements.thread.append(renderProposal(proposal));
  if (state.activeRun && state.activeRun.answerText) {
    const partial = { role: 'assistant', text: state.activeRun.answerText, mode: state.activeRun.mode, partial: true };
    const node = renderMessage(partial);
    if (node) elements.thread.append(node);
  }
  if (state.activeRun?.error) elements.thread.append(renderRunError(state.activeRun.error, state.activeRun.unknown, state.activeRun.finalState));
  if (!messages.length && !state.proposals.length && !state.activeRun) {
    const empty = element('p', 'empty-copy');
    empty.append(element('strong', '', 'Start with the task in front of you'));
    empty.append(document.createTextNode('The saved conversation will appear here. You can review it at any time.'));
    elements.thread.append(empty);
  }
  if (focusKey) {
    for (const candidate of elements.thread.querySelectorAll('[data-focus-key]')) {
      if (candidate.dataset.focusKey === focusKey) {
        candidate.focus({ preventScroll: true });
        break;
      }
    }
  }
  elements.thread.setAttribute('aria-busy', String(Boolean(state.activeRun && !state.activeRun.terminal)));
  if (wasAtBottom || state.scrollToLatest) elements.thread.scrollTop = elements.thread.scrollHeight;
  state.scrollToLatest = false;
}

function renderRunError(message, unknown = false, finalState = '') {
  const box = element('div', 'run-error');
  box.setAttribute('role', 'alert');
  const heading = unknown ? 'Completion is unknown' : finalState === 'turn.completed' ? 'Turn completed without response text' : 'The turn did not complete';
  box.append(element('strong', '', heading));
  box.append(document.createTextNode(message));
  if (unknown) box.append(document.createTextNode(' The request identity is being kept until the server reports a final state.'));
  if (unknown && state.activeRun?.requestId) {
    const run = state.activeRun;
    const check = element('button', 'secondary-button', 'Check saved session');
    check.type = 'button';
    check.dataset.focusKey = 'check-saved-session';
    check.addEventListener('click', () => void reconcileUnknownRun(run));
    box.append(document.createElement('br'), check);
  }
  return box;
}

function renderProposal(proposal) {
  const section = element('article', 'proposal');
  section.dataset.proposalId = typeof proposal.id === 'string' ? proposal.id : '';
  const heading = element('div', 'proposal-heading');
  const title = firstText(proposal, ['title']) || 'Proposal for review';
  heading.append(element('h2', '', title));
  heading.append(element('span', 'proposal-status', firstText(proposal, ['status']) || 'pending'));
  section.append(heading);

  const fields = element('dl', 'proposal-fields');
  appendProposalField(fields, 'Recipient', firstText(proposal, ['recipient']));
  appendProposalField(fields, 'Subject', firstText(proposal, ['subject']));
  appendProposalField(fields, 'Start', firstText(proposal, ['start']));
  appendProposalField(fields, 'End', firstText(proposal, ['end']));
  appendProposalField(fields, 'Time zone', firstText(proposal, ['timeZone', 'timezone']));
  appendProposalField(fields, 'Calendar', firstText(proposal, ['calendar']));
  const body = firstText(proposal, ['body']);
  if (body) appendProposalField(fields, 'Exact proposed text', body, 'proposal-body');
  if (fields.childElementCount) section.append(fields);

  const resultText = asText(proposal.result);
  if (resultText) section.append(element('p', 'proposal-result', resultText));

  const id = firstText(proposal, ['id']);
  const status = firstText(proposal, ['status']).toLowerCase();
  const revision = proposal.revision;
  if (id && (Number.isInteger(revision) || typeof revision === 'string') && status === 'pending') {
    const actions = element('div', 'proposal-actions');
    if (state.lockedProposals.has(id)) {
      const refresh = element('button', 'secondary-button', 'Check saved status');
      refresh.type = 'button';
      refresh.dataset.focusKey = `proposal:${id}:refresh`;
      refresh.disabled = state.busyDecisions.has(id) || Boolean(state.activeRun);
      refresh.addEventListener('click', () => void refreshProposalState(id));
      actions.append(refresh);
    } else {
      const approve = element('button', 'decision-button decision-button--approve', 'Approve');
      approve.type = 'button';
      approve.dataset.focusKey = `proposal:${id}:approve`;
      approve.disabled = state.busyDecisions.has(id) || Boolean(state.activeRun);
      approve.addEventListener('click', () => decideProposal(proposal, 'approve'));
      const reject = element('button', 'decision-button decision-button--reject', 'Reject');
      reject.type = 'button';
      reject.dataset.focusKey = `proposal:${id}:reject`;
      reject.disabled = state.busyDecisions.has(id) || Boolean(state.activeRun);
      reject.addEventListener('click', () => decideProposal(proposal, 'reject'));
      actions.append(approve, reject);
    }
    section.append(actions);
  }
  const error = state.proposalErrors.get(id);
  if (error) {
    const errorNode = element('p', 'proposal-error', error);
    errorNode.setAttribute('role', 'alert');
    section.append(errorNode);
  }
  return section;
}

function appendProposalField(parent, label, value, valueClass = '') {
  if (!value) return;
  const wrap = element('div', 'proposal-field');
  const term = element('dt', '', label);
  const detail = element('dd', valueClass, value);
  wrap.append(term, detail);
  parent.append(wrap);
}

async function decideProposal(proposal, decision) {
  const id = firstText(proposal, ['id']);
  if (!id || state.busyDecisions.has(id) || state.lockedProposals.has(id) || state.activeRun) return;
  state.proposalErrors.delete(id);
  state.busyDecisions.add(id);
  renderThread();
  let decisionAccepted = false;
  try {
    const response = await postJson(`/api/proposals/${encodeURIComponent(id)}/decision`, { decision, revision: proposal.revision }, 'The proposal decision could not be saved.');
    decisionAccepted = true;
    state.lockedProposals.add(id);
    const latest = response && (response.proposal || response.latestProposal);
    if (latest && typeof latest === 'object') {
      replaceProposal(latest);
      if (latest.status !== 'pending') state.lockedProposals.delete(id);
    }
    if (response && response.result !== undefined) {
      const current = state.proposals.find((item) => item.id === id);
      if (current) current.result = response.result;
    }
    try {
      await loadSession({ keepTransient: true });
      const current = state.proposals.find((item) => item.id === id);
      if (current?.status !== 'pending') {
        state.lockedProposals.delete(id);
        state.proposalErrors.delete(id);
      } else {
        state.proposalErrors.set(id, 'The decision was accepted, but the saved proposal still appears pending. Check its status before taking another decision.');
      }
    }
    catch (error) {
      state.proposalErrors.set(id, `The server accepted this decision, but the latest proposal could not be read: ${error instanceof Error ? error.message : 'unknown session read error'}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    const payload = error && typeof error === 'object' ? error.payload : null;
    const latest = payload && typeof payload === 'object' && (payload.proposal || payload.latestProposal);
    if (latest && typeof latest === 'object') {
      replaceProposal(latest);
      if (latest.status !== 'pending') state.lockedProposals.delete(id);
    }
    const uncertain = !error?.status || error.status >= 500;
    if (uncertain) state.lockedProposals.add(id);
    let refreshed = false;
    try { await loadSession({ keepTransient: true }); refreshed = true; } catch { /* The proposal stays visible with its last known revision. */ }
    const current = state.proposals.find((item) => item.id === id);
    if (refreshed && current?.status !== 'pending') state.lockedProposals.delete(id);
    state.proposalErrors.set(id, decisionAccepted
      ? `The server accepted this decision, but its exact result could not be read: ${detail}`
      : `The proposal decision could not be confirmed: ${detail}${refreshed ? ' The saved proposal state was refreshed.' : ''}${uncertain ? ' A second decision is held until its status is known.' : ''}`);
  } finally {
    state.busyDecisions.delete(id);
    renderThread();
  }
}

async function refreshProposalState(id) {
  if (!id || state.busyDecisions.has(id) || state.activeRun) return;
  state.busyDecisions.add(id);
  try {
    await loadSession({ keepTransient: true });
    const proposal = state.proposals.find((item) => item.id === id);
    if (proposal && proposal.status !== 'pending') {
      state.lockedProposals.delete(id);
      state.proposalErrors.delete(id);
    } else {
      state.proposalErrors.set(id, 'The saved proposal still appears pending. The previous decision outcome is unresolved, so another decision is held.');
    }
  } catch (error) {
    state.proposalErrors.set(id, `The saved proposal status could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    state.busyDecisions.delete(id);
    renderThread();
  }
}

function replaceProposal(next) {
  const index = state.proposals.findIndex((proposal) => proposal.id === next.id);
  if (index < 0) state.proposals.push(next);
  else state.proposals[index] = next;
}

function normalizeActivity(event) {
  if (!event || typeof event !== 'object') return null;
  const rawType = firstText(event, ['type', 'event', 'kind']);
  const type = rawType.startsWith('tool.') ? 'tool' : rawType.startsWith('turn.') ? 'turn' : rawType;
  const label = firstText(event, ['label', 'name', 'message']) || rawType;
  if (!label) return null;
  const stateText = firstText(event, ['status']);
  const status = stateText || (event.success === true ? 'completed' : event.success === false ? 'failed' : '');
  return { type, label, state: status, success: typeof event.success === 'boolean' ? event.success : undefined };
}

function renderActivity() {
  elements.activityList.replaceChildren();
  const sourceItems = state.activity.map(normalizeActivity).filter(Boolean).slice(-8);
  if (state.activeRun) sourceItems.push(...state.activeRun.activity.map(normalizeActivity).filter(Boolean));
  const seen = new Set();
  const items = sourceItems.filter((item) => {
    const key = `${item.type}|${item.label}|${item.state}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!items.length) {
    elements.activityList.append(element('li', 'activity-empty', 'Activity will appear here when the server reports it.'));
    return;
  }
  for (const item of items) {
    const row = element('li');
    const dot = element('span', 'activity-dot');
    const failed = item.success === false || item.state === 'failed';
    if (failed) dot.dataset.state = 'failed';
    dot.setAttribute('aria-hidden', 'true');
    const label = `${item.type ? `${item.type}: ` : ''}${item.label}${item.state ? ` (${item.state})` : ''}`;
    row.append(dot, document.createTextNode(label));
    elements.activityList.append(row);
  }
}

function updateComposer() {
  const liveEnabled = state.session?.liveEnabled === true;
  const activeRun = state.activeRun;
  const unsettled = Boolean(activeRun);
  elements.replyInput.disabled = !liveEnabled || unsettled || state.loading || !state.session;
  elements.replyButton.disabled = !liveEnabled || unsettled || state.loading || !state.session || !elements.replyInput.value.trim();
  elements.replyButton.textContent = activeRun?.terminal ? 'Reply' : 'Reply';
  elements.stopButton.hidden = !(activeRun && activeRun.kind === 'turn' && !activeRun.terminal);
  elements.stopButton.disabled = !activeRun || activeRun.stopRequested || activeRun.stopSending;
  for (const button of elements.replayList.querySelectorAll('button')) button.disabled = !state.session || unsettled || state.loading;
  elements.resetOpen.disabled = !state.session || state.loading || unsettled || state.resetBusy;
  const blocker = typeof state.session?.liveBlocker === 'string' ? state.session.liveBlocker.trim() : '';
  elements.composerNote.textContent = !liveEnabled
    ? blocker || 'Saved history and offline replays are available.'
    : unsettled
      ? activeRun.terminal ? 'The turn finished. Refreshing saved history…' : activeRun.unknown ? 'The request may still be running. Wait for a final server event before sending again.' : 'Waiting for the server to finish this turn.'
      : 'Replies are prepared for review. Email and calendar effects remain simulated.';
}

function render() {
  renderTaskList();
  renderReplays();
  renderHeader();
  renderThread();
  renderActivity();
  updateComposer();
  renderGlobalError();
}

function addActivity(type, label, extra = {}) {
  if (!state.activeRun) return;
  const item = { type, label, ...extra };
  state.activeRun.activity.push(item);
  renderActivity();
}

function isCurrentRun(run) {
  return state.activeRun === run && run.serial === state.runSerial;
}

function eventTurnId(event) {
  return typeof event.turnId === 'string' ? event.turnId : '';
}

function acceptEvent(run, event) {
  if (!isCurrentRun(run) || !event || typeof event !== 'object' || typeof event.type !== 'string') return;
  const type = event.type;
  const eventTurn = eventTurnId(event);
  if (run.turnId && eventTurn && run.turnId !== eventTurn) return;
  if (run.terminal) return;

  if (type === 'turn.started') {
    if (!eventTurn) {
      failProtocol(run, 'The server started a turn without an ID. No answer has been assumed.');
      return;
    }
    if (run.turnId === eventTurn) return;
    if (run.turnId) return;
    run.turnId = eventTurn;
    run.started = true;
    addActivity(type, 'Turn started', { status: 'started' });
    return;
  }

  if (type === 'tool.started' || type === 'tool.completed') {
    const itemId = firstText(event, ['itemId']);
    const key = itemId ? `${type}:${itemId}` : '';
    if (key && run.seenToolEvents.has(key)) return;
    if (key) run.seenToolEvents.add(key);
    const label = firstText(event, ['label', 'name']) || 'Tool activity';
    const status = type === 'tool.started' ? 'started' : event.success === false ? 'failed' : 'completed';
    addActivity(type, label, { success: event.success, status });
    return;
  }

  if (type === 'message.delta') {
    if (typeof event.text !== 'string') {
      failProtocol(run, 'The server sent an invalid message update. No partial answer is shown.');
      return;
    }
    run.answerText += event.text;
    renderThread();
    return;
  }

  if (type === 'turn.completed') {
    const terminalKey = `${type}:${eventTurn || 'current'}`;
    if (run.seenTerminal.has(terminalKey)) return;
    run.seenTerminal.add(terminalKey);
    if (typeof event.answer === 'string') run.answerText = event.answer;
    run.mode = firstText(event, ['mode']) || run.mode;
    if (run.kind === 'replay' && run.mode !== 'offline_replay') {
      run.terminal = true;
      run.finalState = 'turn.completed';
      run.unknown = false;
      run.answerText = '';
      run.error = 'The replay did not identify itself as offline. Its result has been withheld.';
      showGlobalError(run.error);
      state.activeRun = null;
      render();
      return;
    }
    run.error = run.answerText ? '' : 'The server completed the turn without response text. No answer is shown.';
    run.terminal = true;
    run.finalState = type;
    const proposals = Array.isArray(event.proposals) ? event.proposals : [];
    for (const proposal of proposals) if (proposal && typeof proposal.id === 'string') replaceProposal(proposal);
    if (run.answerText) {
      addTransientMessage({ role: 'assistant', text: run.answerText, mode: run.mode, turnId: run.turnId, requestId: run.requestId });
    }
    addActivity(type, run.mode === 'offline_replay' ? 'Offline example finished' : 'Turn completed', { status: 'completed' });
    run.unknown = false;
    if (run.error) showGlobalError(run.error);
    render();
    void refreshAfterRun(run);
    return;
  }

  if (type === 'turn.failed') {
    const terminalKey = `${type}:${eventTurn || 'current'}`;
    if (run.seenTerminal.has(terminalKey)) return;
    run.seenTerminal.add(terminalKey);
    run.terminal = true;
    run.finalState = type;
    run.answerText = '';
    run.unknown = false;
    run.error = [firstText(event, ['code']), firstText(event, ['message'])].filter(Boolean).join(': ') || 'The server reported that this turn failed.';
    addActivity(type, run.error, { status: 'failed', success: false });
    showGlobalError(`The turn failed: ${run.error}`);
    render();
    void refreshAfterRun(run);
    return;
  }

  if (type === 'turn.interrupted') {
    const terminalKey = `${type}:${eventTurn || 'current'}`;
    if (run.seenTerminal.has(terminalKey)) return;
    run.seenTerminal.add(terminalKey);
    run.terminal = true;
    run.finalState = type;
    run.answerText = '';
    run.unknown = false;
    run.error = 'The server confirmed that the turn was interrupted.';
    addActivity(type, firstText(event, ['status']) || 'Turn interrupted', { status: 'interrupted' });
    showGlobalError(run.error);
    render();
    void refreshAfterRun(run);
    return;
  }

  addActivity('event', `Unrecognised server event: ${type}`);
}

function failProtocol(run, message) {
  if (!isCurrentRun(run) || run.terminal) return;
  run.finalState = 'protocol_error';
  run.answerText = '';
  run.error = message;
  run.unknown = !run.replay;
  render();
}

async function readJsonLines(response, run) {
  if (!response.ok) {
    const payload = await response.text();
    let parsed = payload;
    try { parsed = JSON.parse(payload); } catch { /* Keep the response as plain text. */ }
    throw new Error(apiErrorMessage(parsed, `The turn could not be started (HTTP ${response.status})`));
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('This browser cannot read the server response as a stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotTerminal = false;
  let streamError = '';

  function parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try { event = JSON.parse(trimmed); }
    catch { throw new Error('The server sent an invalid activity line. The response could not be safely completed.'); }
    acceptEvent(run, event);
    const eventTurn = eventTurnId(event);
    const matchesTurn = !run.turnId || !eventTurn || eventTurn === run.turnId;
    if (event && TERMINAL_TYPES.has(event.type) && isCurrentRun(run) && matchesTurn) gotTerminal = true;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        parseLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseLine(buffer.replace(/\r$/, ''));
  } catch (error) {
    streamError = error instanceof Error ? error.message : 'The server stream could not be read.';
  } finally {
    try { reader.releaseLock(); } catch { /* The browser may already have released the stream. */ }
  }

  if (!isCurrentRun(run)) return;
  if (streamError) {
    if (!run.terminal && run.replay) finishReplayFailure(run, streamError);
    else if (!run.terminal) {
      run.unknown = true;
      run.error = streamError;
      render();
      void reconcileUnknownRun(run);
    }
    return;
  }
  if (!gotTerminal && !run.terminal) {
    if (run.replay) finishReplayFailure(run, 'The replay ended without a final event. No result is shown.');
    else {
      run.unknown = true;
      run.error = 'The connection ended before the server confirmed a final state. No completion is claimed.';
      render();
      void reconcileUnknownRun(run);
    }
  }
}

function finishReplayFailure(run, message) {
  if (!isCurrentRun(run)) return;
  run.terminal = true;
  run.finalState = 'replay_error';
  run.unknown = false;
  run.answerText = '';
  run.error = message;
  showGlobalError(`Offline replay failed: ${message}`);
  state.activeRun = null;
  render();
}

function beginRun(kind, taskId, requestId = '', visibleQuestion = '') {
  const task = TASKS.find((item) => item.id === taskId) || currentTask();
  state.runSerial += 1;
  const run = {
    serial: state.runSerial,
    requestId,
    kind,
    replay: kind === 'replay',
    taskId: task.id,
    mode: kind === 'replay' ? 'offline_replay' : '',
    turnId: '',
    started: false,
    terminal: false,
    finalState: '',
    answerText: '',
    error: '',
    unknown: false,
    stopRequested: false,
    stopSending: false,
    activity: [],
    seenToolEvents: new Set(),
    seenTerminal: new Set()
  };
  state.activeRun = run;
  state.selectedTask = task.id;
  state.proposalErrors.clear();
  addTransientMessage({ role: 'user', text: visibleQuestion || elements.replyInput.value.trim() || task.prompt, mode: '', timestamp: new Date().toISOString(), requestId });
  render();
  return run;
}

async function startTurn(question) {
  if (state.session?.liveEnabled !== true || state.activeRun) return;
  const requestId = crypto.randomUUID();
  const run = beginRun('turn', state.selectedTask, requestId, question);
  elements.replyInput.value = '';
  updateComposer();
  clearGlobalError();
  try {
    const response = await fetch('/api/turns', {
      method: 'POST',
      headers: csrfHeaders(),
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ requestId, question })
    });
    await readJsonLines(response, run);
  } catch (error) {
    if (!isCurrentRun(run) || run.terminal) return;
    run.unknown = true;
    run.error = error instanceof Error ? error.message : 'The request could not be confirmed.';
    render();
    void reconcileUnknownRun(run);
  }
}

async function startReplay(taskId) {
  if (state.activeRun || state.loading || !state.session) return;
  const task = TASKS.find((item) => item.id === taskId);
  if (!task) return;
  state.selectedTask = task.id;
  state.hasUserSelectedTask = true;
  renderHeader();
  renderTaskList();
  const requestId = crypto.randomUUID();
  const run = beginRun('replay', task.id, requestId, task.prompt);
  clearGlobalError();
  try {
    const response = await fetch('/api/replay', {
      method: 'POST',
      headers: csrfHeaders(),
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ scenario: task.id, requestId })
    });
    await readJsonLines(response, run);
  } catch (error) {
    if (!isCurrentRun(run) || run.terminal) return;
    finishReplayFailure(run, error instanceof Error ? error.message : 'The offline replay could not be read.');
  }
}

async function refreshAfterRun(run) {
  if (!isCurrentRun(run) || !run.terminal) return;
  try {
    await loadSession({ keepTransient: true });
    if (!isCurrentRun(run)) return;
    // Persisted history is authoritative; transient rows disappear only after this read succeeds.
    state.transientMessages = state.transientMessages.filter((message) => !state.serverMessages.some((saved) => {
      const sameRole = roleFor(saved) === roleFor(message);
      const sameRequest = run.requestId && firstText(saved, ['requestId', 'request_id']) === run.requestId;
      const sameText = textForMessage(saved) === textForMessage(message);
      return sameRole && (sameRequest || sameText);
    }));
  } catch (error) {
    if (isCurrentRun(run)) showGlobalError(`The turn finished, but saved history could not be refreshed: ${error instanceof Error ? error.message : 'Unknown session read error.'}`);
  }
  if (isCurrentRun(run)) {
    if (run.error && !run.unknown) showGlobalError(run.error);
    state.activeRun = null;
    render();
  }
}

async function reconcileUnknownRun(run) {
  if (!isCurrentRun(run) || run.terminal || run.reconciling) return;
  run.reconciling = true;
  try {
    const session = await loadSession({ keepTransient: true });
    if (!isCurrentRun(run) || run.terminal) return;
    const records = arrayValue(session.activity);
    const matches = records.filter((record) => {
      if (!record || typeof record !== 'object') return false;
      const requestMatch = firstText(record, ['requestId', 'request_id']) === run.requestId;
      const turnMatch = run.turnId && eventTurnId(record) === run.turnId;
      return requestMatch || turnMatch;
    });
    const savedAnswer = arrayValue(session.messages).find((message) => firstText(message, ['requestId', 'request_id']) === run.requestId && roleFor(message) === 'assistant' && textForMessage(message));
    const terminalStatus = (record) => {
      const kind = firstText(record, ['type', 'kind']);
      const status = firstText(record, ['status']).toLowerCase();
      return kind === 'turn' && ['completed', 'complete', 'succeeded', 'failed', 'interrupted'].includes(status);
    };
    const match = [...matches].reverse().find(terminalStatus);
    const matchStatus = match ? firstText(match, ['status']).toLowerCase() : '';
    if (matchStatus === 'failed') {
      acceptEvent(run, { type: 'turn.failed', code: firstText(match, ['code']), message: firstText(match, ['label']) || 'The saved session records a failed turn.' });
      return;
    }
    if (matchStatus === 'interrupted') {
      acceptEvent(run, { type: 'turn.interrupted', status: firstText(match, ['label']) || 'Turn interrupted' });
      return;
    }
    if (savedAnswer) {
      acceptEvent(run, {
        type: 'turn.completed',
        answer: textForMessage(savedAnswer),
        mode: firstText(savedAnswer, ['mode']),
        proposals: session.proposals
      });
      return;
    }
    if (match) {
      acceptEvent(run, {
        type: 'turn.completed',
        answer: '',
        mode: firstText(match, ['mode']),
        proposals: session.proposals
      });
      return;
    }
    run.error = 'The saved session does not yet include a final event for this request. The request remains unresolved.';
    render();
  } catch (error) {
    if (isCurrentRun(run) && !run.terminal) {
      run.error = `The saved session could not confirm this request: ${error instanceof Error ? error.message : 'unknown error'}`;
      render();
    }
  } finally {
    if (isCurrentRun(run)) run.reconciling = false;
  }
}

async function stopTurn() {
  const run = state.activeRun;
  if (!run || run.kind !== 'turn' || run.terminal || run.stopRequested || run.stopSending) return;
  run.stopSending = true;
  render();
  try {
    await postJson('/api/stop', { requestId: run.requestId }, 'The stop request was not accepted.');
    if (!isCurrentRun(run)) return;
    run.stopRequested = true;
    run.error = 'Stop requested. Waiting for the server to report the final state. This does not confirm a billing cancellation.';
    run.unknown = true;
  } catch (error) {
    if (!isCurrentRun(run)) return;
    run.error = `Stop could not be confirmed: ${error instanceof Error ? error.message : 'unknown error'}. The original request is still unresolved.`;
    run.unknown = true;
  } finally {
    if (isCurrentRun(run)) {
      run.stopSending = false;
      render();
    }
  }
}

async function resetDemo() {
  if (state.activeRun) return;
  if (state.resetBusy) return;
  state.resetBusy = true;
  let resetAccepted = false;
  clearGlobalError();
  updateComposer();
  elements.resetConfirm.disabled = true;
  try {
    await postJson('/api/reset', {}, 'The demo could not be reset.');
    resetAccepted = true;
    state.transientMessages = [];
    state.proposalErrors.clear();
    state.lockedProposals.clear();
    state.activity = [];
    state.serverMessages = [];
    state.proposals = [];
    state.session = null;
    state.loading = true;
    elements.replyInput.value = TASKS[0].prompt;
    state.selectedTask = 'quotation';
    render();
    await loadSession();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    if (resetAccepted) {
      state.session = null;
      state.serverMessages = [];
      state.proposals = [];
      state.activity = [];
      state.loading = false;
      state.sessionLoadFailed = true;
      showGlobalError(`The reset was accepted, but the fresh fictional session could not be read: ${detail}`);
    } else {
      showGlobalError(`The reset could not be confirmed: ${detail}`);
    }
  } finally {
    state.resetBusy = false;
    elements.resetConfirm.disabled = false;
    elements.resetDialog.close();
    render();
  }
}

elements.replyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = elements.replyInput.value.trim();
  if (!question || state.session?.liveEnabled !== true || state.activeRun) return;
  void startTurn(question);
});

elements.replyInput.addEventListener('input', updateComposer);
elements.stopButton.addEventListener('click', () => void stopTurn());
elements.resetOpen.addEventListener('click', () => {
  if (!state.loading && !state.activeRun) elements.resetDialog.showModal();
});
elements.resetCancel.addEventListener('click', () => elements.resetDialog.close());
elements.resetConfirm.addEventListener('click', () => void resetDemo());
elements.resetDialog.addEventListener('click', (event) => {
  if (event.target === elements.resetDialog) elements.resetDialog.close();
});

elements.replyInput.value = TASKS[0].prompt;
renderTaskList();
renderReplays();
updateComposer();
loadSession().catch((error) => {
  state.loading = false;
  state.serverMessages = [];
  state.proposals = [];
  state.activity = [];
  state.transientMessages = [];
  showGlobalError(error instanceof Error ? error.message : 'The fictional session could not be opened.');
  render();
});
