// @ts-check
/* Pure pull lifecycle: one operation id, explicit states, and late progress rejection. */
const PULL_STATES = Object.freeze([
  'idle', 'validating', 'reading', 'planning', 'writing', 'refreshing',
  'completed', 'completed-with-warnings', 'failed', 'cancelled',
]);
const PULL_TRANSITIONS = Object.freeze({
  idle: ['validating'], validating: ['reading', 'failed', 'cancelled'],
  reading: ['planning', 'failed', 'cancelled'], planning: ['writing', 'failed', 'cancelled'],
  writing: ['refreshing', 'failed', 'cancelled'], refreshing: ['completed', 'completed-with-warnings', 'failed', 'cancelled'],
  completed: ['validating'], 'completed-with-warnings': ['validating'],
  failed: ['validating'], cancelled: ['validating'],
});

function createPullLifecycle() {
  let state = 'idle', operationId = 0, lastProgress = null;
  function begin() {
    if (!PULL_TRANSITIONS[state].includes('validating')) return null;
    operationId += 1; state = 'validating'; lastProgress = null;
    return operationId;
  }
  function transition(next, id = operationId) {
    if (id !== operationId || !PULL_STATES.includes(next) || !PULL_TRANSITIONS[state].includes(next)) return false;
    state = next; return true;
  }
  function progress(event, id = operationId) {
    if (id !== operationId || !event || typeof event.stage !== 'string') return false;
    lastProgress = Object.freeze({ ...event, operationId: id }); return true;
  }
  function finish(warnings = false, id = operationId) {
    if (id !== operationId || !PULL_STATES.includes(state)) return false;
    return state === 'refreshing' && transition(warnings ? 'completed-with-warnings' : 'completed', id);
  }
  function fail(id = operationId) { return transition('failed', id); }
  function cancel(id = operationId) { return transition('cancelled', id); }
  function snapshot() { return Object.freeze({ state, operationId, progress: lastProgress }); }
  return Object.freeze({ begin, transition, progress, finish, fail, cancel, snapshot });
}
