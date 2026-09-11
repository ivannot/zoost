// @ts-check
/** @typedef {'upstream-contract'|'permission'|'workspace-mismatch'|'partial-response'|'authentication'|'filesystem'|'configuration'|'cancelled'|'internal'} ZoostErrorCode */
/** @typedef {{code: ZoostErrorCode, area: string, severity: 'warning'|'error', retryable: boolean, uiKey: string, cause?: unknown}} ZoostErrorInfo */
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
  else if ((error && (error.status === 429 || error.status >= 500)) || text.includes('network') || text.includes('timeout') || text.includes('fetch failed')) { code = 'upstream-contract'; retryable = true; }
  else if (text.includes('configuration') || text.includes('missing environment') || text.includes('not configured')) code = 'configuration';
  else if (text.includes('partial') || text.includes('incomplete')) code = 'partial-response';
  else if (text.includes('workspace') && text.includes('mismatch')) code = 'workspace-mismatch';
  else if (text.includes('cancel')) code = 'cancelled';
  else if (text.includes('file') || text.includes('directory')) code = 'filesystem';
  return createZoostError({ code, area, severity: code === 'internal' ? 'error' : 'warning', retryable, uiKey: code, cause: error });
}
