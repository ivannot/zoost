/* Navigation history state, without DOM or product data.
 *
 * A panel decides what an entry opens and how it is drawn. This object owns only the browser-like
 * rules of the walk: a repeated arrival updates the current entry, a new arrival drops the forward
 * tail, replay does not record itself, and the oldest entry falls off at the limit.
 */

function createNavigationState(limit = 50, clock = Date.now) {
  const cap = Math.max(1, Number(limit) || 1);
  let entries = [];
  let position = -1;
  let sequence = 0;
  let replaying = false;

  function snapshot() {
    return {
      entries: entries.map((entry) => Object.assign({}, entry)),
      position,
      replaying,
      canBack: position > 0,
      canForward: position >= 0 && position < entries.length - 1,
    };
  }

  function record(key, fields = {}) {
    if (replaying || key === null || key === undefined || key === '') return null;
    const identity = String(key);
    const current = entries[position];
    if (current && current.key === identity) {
      Object.assign(current, fields, { key: identity });
      return snapshot();
    }
    entries = entries.slice(0, position + 1);
    entries.push(Object.assign({}, fields, { n: ++sequence, key: identity, at: clock() }));
    if (entries.length > cap) entries.shift();
    position = entries.length - 1;
    return snapshot();
  }

  function updateCurrent(fields) {
    if (position < 0 || !entries[position] || !fields) return null;
    Object.assign(entries[position], fields);
    return snapshot();
  }

  function clear() {
    entries = [];
    position = -1;
    replaying = false;
    return snapshot();
  }

  function keepCurrent() {
    const current = entries[position];
    entries = current ? [current] : [];
    position = entries.length - 1;
    replaying = false;
    return snapshot();
  }

  function startReplay(nextPosition) {
    if (nextPosition < 0 || nextPosition >= entries.length || nextPosition === position) return null;
    position = nextPosition;
    replaying = true;
    return Object.assign({}, entries[position]);
  }

  function finishReplay() {
    replaying = false;
    return snapshot();
  }

  return { snapshot, record, updateCurrent, clear, keepCurrent, startReplay, finishReplay };
}
