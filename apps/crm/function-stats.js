/* CRM function statistics: a pure projection of source already held by the mirror. */
const ZOHO_SERVICES = 'crm|creator|books|invoice|inventory|billing|subscriptions|desk|projects|people|recruit|mail|calendar|sheet|writer|cliq|connect|sign|analytics|bookings|salesiq|workdrive|map|notebook';
const RE_ZOHO_ANY = new RegExp('\\bzoho\\.(?:' + ZOHO_SERVICES + ')\\.\\w+', 'gi');
const RE_ZOHO_CRM = /\bzoho\.crm\.\w+/gi;
const RE_INVOKEURL = /\binvokeurl\b/gi;
const RE_SENDMAIL = /\bsendmail\b/gi;
const countFnStats = (s, re) => { const m = s.match(re); return m ? m.length : 0; };

/** @param {string|null|undefined} src @returns {object|null} */
function fnStats(src) {
  if (src === null || src === undefined) return null;
  const code = String(src);
  const bare = stripNonCode(code);
  const crm = countFnStats(bare, RE_ZOHO_CRM);
  const zohoAny = countFnStats(bare, RE_ZOHO_ANY);
  const invokeurl = countFnStats(bare, RE_INVOKEURL);
  return {
    lines: code ? code.split('\n').length : 0,
    codeLines: bare.split('\n').filter((l) => l.trim() !== '').length,
    chars: code.length,
    invokeurl, sendmail: countFnStats(bare, RE_SENDMAIL),
    crm, zoho: zohoAny - crm, apiCalls: invokeurl + zohoAny,
  };
}
