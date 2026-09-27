// @ts-check
/** @typedef {'upstream-unavailable'|'rate-limited'|'upstream-contract'|'permission'|'workspace-mismatch'|'partial-response'|'authentication'|'filesystem'|'configuration'|'cancelled'|'internal'} ZoostErrorCode */
/** @typedef {{code: ZoostErrorCode, area: string, severity: 'warning'|'error', retryable: boolean, uiKey: string, upstreamCode?: string, detail?: unknown, cause?: unknown}} ZoostErrorInfo */
function createZoostError(info) {
  const error = new Error(info.uiKey);
  Object.assign(error, info);
  return error;
}
function classifyZoostError(error, area = 'unknown') {
  const text = String(error && error.message || error || '').toLowerCase();
  let code = 'internal', retryable = false;
  if ((error && error.status === 401) || text.includes('csrf') || /\b401\b/.test(text) || text.includes('unauthor')) { code = 'authentication'; retryable = true; }
  else if ((error && (error.status === 403 || error.forbidden)) || text.includes('permission') || text.includes('forbidden') || text.includes('denied')) code = 'permission';
  else if (error && error.status === 429 || text.includes('rate limit') || text.includes('too many requests')) { code = 'rate-limited'; retryable = true; }
  else if ((error && error.status >= 500) || text.includes('network') || text.includes('timeout') || text.includes('fetch failed') || text.includes('service unavailable')) { code = 'upstream-unavailable'; retryable = true; }
  else if (error && (error.upstreamContract || error.upstreamCode === 'UPSTREAM_CONTRACT' || error.code === 'UPSTREAM_CONTRACT') || text.includes('schema mismatch') || text.includes('unexpected response') || text.includes('invalid response shape')) code = 'upstream-contract';
  else if (text.includes('configuration') || text.includes('missing environment') || text.includes('not configured')) code = 'configuration';
  else if (text.includes('partial') || text.includes('incomplete')) code = 'partial-response';
  else if (text.includes('workspace') && text.includes('mismatch')) code = 'workspace-mismatch';
  else if (text.includes('cancel')) code = 'cancelled';
  else if (text.includes('file') || text.includes('directory')) code = 'filesystem';
  return createZoostError({ code, area, severity: code === 'internal' ? 'error' : 'warning', retryable, uiKey: code, cause: error });
}

/** Whether this panel already accounts for a failure - in which case neither «A fix may already be
 *  released» nor «Report this problem» has anything to offer the reader.
 *
 *  The rule was written beside the CRM's pull failure as «a failure this panel can explain in Zoho's
 *  terms is not one a release changes», and it was tested by reading two ad-hoc marks: `forbidden`,
 *  which only a 401 or a 403 sets, and `note`, which one branch of one bridge writes. A pull that
 *  Zoho rate-limited carries neither, so the panel said «wait a moment, then try again» and offered
 *  both affordances underneath it - reported from a real org: «se è un problema di rate limit,
 *  perchè dire di riportare il problema o che potrebbe già esserci una fix?». Nothing was wrong
 *  with the rule; it was being asked of the wrong evidence.
 *
 *  So it is asked of the classification instead, which is the vocabulary that already divides these.
 *  Listed positively, because the answer for a code nobody has thought about yet must be «report
 *  it»: a new code defaults to offering both, and forgetting to add one here costs a redundant
 *  button rather than a lost report. The four left out are the ones where this product may be at
 *  fault - `internal`, `upstream-contract` (Zoho answered in a shape this version does not
 *  understand, which is exactly what a release fixes), `partial-response` and `filesystem`.
 */
const ACCOUNTED_FOR = ['permission', 'rate-limited', 'authentication', 'upstream-unavailable',
                       'configuration', 'workspace-mismatch', 'cancelled'];
function accountedFor(error) {
  if (!error) return false;
  // `forbidden` predates the classification and still arrives on errors that never pass through it -
  // a controller failure, a bridge reply read before `classifyZoostError` exists. `note` is
  // deliberately *not* here: it is a refusal Zoho worded some other way, which the panel repeats
  // «hedged where the knowledge stops», so there is still something for somebody to look at. Its
  // caller withholds the link and keeps the button, and that asymmetry is the point of it.
  if (error.forbidden) return true;
  return ACCOUNTED_FOR.indexOf(error.uiKey || error.code) !== -1;
}
