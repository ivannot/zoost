// @ts-check
/* Search-box state, without DOM or product data.
 *
 * The panel decides how a query is executed and drawn. This object keeps the inseparable parts of
 * the reader's intent together: the text, whether it means a name or full text, whether full text is
 * a regular expression, and the tab the intent belongs to.
 */

/** @typedef {{text: string, mode: string, regex: boolean}} SearchValue */
/** @typedef {{fullTextScope?: string, fullTextMode?: string, scope?: string}} SearchOptions */

/** @param {SearchOptions} [options] */
function createSearchState(options = {}) {
  const fullTextScope = String(options.fullTextScope || '');
  const fullTextMode = String(options.fullTextMode || 'content');
  let scope = String(options.scope || fullTextScope || 'main');
  const states = new Map();

  const blank = () => ({ text: '', mode: 'name', regex: false });
  /** @param {SearchValue} state */
  const copy = (state) => ({ scope, text: state.text, mode: state.mode, regex: state.regex,
    fullText: state.mode === fullTextMode });

  /** @param {SearchValue | null | undefined} value @param {string} [forScope] */
  function normalize(value, forScope = scope) {
    const state = value || blank();
    const mode = forScope === fullTextScope && state.mode === fullTextMode ? fullTextMode : 'name';
    return { text: String(state.text || ''), mode, regex: mode === fullTextMode && !!state.regex };
  }

  function current() {
    if (!states.has(scope)) states.set(scope, blank());
    return states.get(scope);
  }

  function snapshot() { return copy(current()); }

  /** @param {unknown} nextScope */
  function enter(nextScope) {
    scope = String(nextScope || 'main');
    states.set(scope, normalize(states.get(scope), scope));
    return snapshot();
  }

  /** @param {unknown} text */
  function setText(text) {
    current().text = String(text == null ? '' : text);
    return snapshot();
  }

  function toggleMode() {
    const state = current();
    if (scope !== fullTextScope) return snapshot();
    if (state.mode === fullTextMode) {
      state.mode = 'name';
      if (state.regex) { state.regex = false; state.text = ''; }
    } else {
      state.mode = fullTextMode;
    }
    return snapshot();
  }

  function toggleRegex() {
    const state = current();
    if (state.mode !== fullTextMode) return snapshot();
    state.regex = !state.regex;
    if (!state.regex) state.text = '';
    return snapshot();
  }

  /** @param {unknown} text */
  function usePattern(text) {
    const state = current();
    if (scope !== fullTextScope) return snapshot();
    state.text = String(text == null ? '' : text);
    state.mode = fullTextMode;
    state.regex = true;
    return snapshot();
  }

  function useNames(keepText = true) {
    const state = current();
    state.mode = 'name';
    state.regex = false;
    if (!keepText) state.text = '';
    return snapshot();
  }

  function reset() {
    states.clear();
    states.set(scope, blank());
    return snapshot();
  }

  return { snapshot, enter, setText, toggleMode, toggleRegex, usePattern, useNames, reset };
}
