/* CRM mirror and presentation helpers shared by the panel's classic scripts. */
// A comparator over one field, with the `|| ''` the sites all carried: `.sort(byField('name'))`.
const byField = (k) => (a, b) => (a[k] || '').localeCompare(b[k] || '');
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// escHtml is NOT attribute-safe (it leaves " alone). Use escA inside an attribute value, or a
// double quote in the data closes it early and truncates - the trap that halved the getRelated snippet.
// Attribute-safe: `&`, `<`, `>`, and **both** quote characters. escHtml() does not escape quotes, and
// a quote inside an attribute closes it early - that is what cut the getRelatedRecords snippet in
// half. Escaping both quote styles means a reader never has to work out which one the attribute
// used, and the two graph windows already did it this way.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Already through `escHtml`, so `& < >` are encoded; what is left is the delimiter that decides
// where an attribute ends. `escA` cannot be used here - it encodes `&` too, and this value has been
// encoded once already, so the query string of every link the assistant writes would come out as
// `&amp;amp;`. Named rather than inline, because `tools/htmlcheck.py` reads the name to know an
// attribute is safe, and a check that cannot see the escaping is a check that will be argued with.
// The two delimiters written as escapes, not as themselves: a regex literal containing a quote is
// the trap this repository already records against `sliceConst`, and it bites every scanner that
// reads JavaScript without parsing it - the duplicate-message check and the slicer both lost their
// place on the first version of this line.
const escQ = (s) => String(s).replace(/[\u0022\u0027]/g, (c) => (c === '\u0022' ? '&quot;' : '&#39;'));
const sanitize = (s) => String(s).replace(/[^\w.\-]/g, '_');
// Deluge is a single source file; Java, Python and Node are projects. The distinction remains useful
// for static analysis (the Deluge parser must not be run over another language), not for mirroring:
// every language Zoho lists is downloaded.
const isDeluge = (lang) => !lang || /^deluge/i.test(String(lang));
const langLabel = (lang) => (isDeluge(lang) ? 'Deluge' : String(lang).replace(/_/g, ' '));
// Zoho spells a language with its runtime in it - `java`, `java17`, `nodejs`, `nodejs_22`,
// `python_3_12` - and that is the right thing to *record*: a mirror that flattened it would lose
// which runtime a function is compiled for. It is the wrong thing to put in a menu, where it became
// six entries and two of them read «nodejs 22» and «python 3 12». The family is what somebody
// filters or sorts by; the version stays on the row, in the details and in both reports.
const LANG_FAMILY = [
  ['deluge', 'Deluge', /^deluge/i],
  ['java', 'Java', /^java/i],
  ['nodejs', 'Node.js', /^node/i],
  ['python', 'Python', /^py/i],
];
// Ordered as above rather than alphabetically: Deluge is what almost every org has, and a list that
// buries it under Java reads as though the others were the usual case.
const langFamily = (lang) => (LANG_FAMILY.find(([, , re]) => re.test(String(lang || 'deluge')))
  || [String(lang || 'deluge')])[0];
// A language nobody here has a name for keeps the name Zoho gave it: inventing a family for it
// would be a guess, and «what is this?» is better asked with their word than with ours.
const langFamilyLabel = (fam) => (LANG_FAMILY.find(([k]) => k === fam) || [])[1] || String(fam);
const fnMetaPath = (folder, stem) => `functions/${folder}/${stem}.meta.json`;
const fnProjectRoot = (folder, stem) => `functions/${folder}/${stem}.files`;
const fnDefaultPath = (folder, stem, language) => isDeluge(language)
  ? `functions/${folder}/${stem}.dg` : fnProjectRoot(folder, stem);
function pathsFromMeta(meta, metaPath) {
  const base = metaPath.replace(/\.meta\.json$/, '');
  if (isDeluge(meta && meta.language)) return [base + '.dg', metaPath];
  const root = base + '.files/';
  return (meta && Array.isArray(meta.files) ? meta.files.map((p) => root + p) : []).concat(metaPath);
}
function directoriesFromMeta(meta, metaPath) {
  if (isDeluge(meta && meta.language)) return [];
  const root = metaPath.replace(/\.meta\.json$/, '.files/');
  return meta && Array.isArray(meta.directories) ? meta.directories.map((p) => root + p) : [];
}
function primaryFromMeta(meta, metaPath) {
  if (isDeluge(meta && meta.language)) return metaPath.replace(/\.meta\.json$/, '.dg');
  const files = Array.isArray(meta && meta.files) ? meta.files : [];
  const primary = meta && meta.primary_file || files[0];
  return primary ? metaPath.replace(/\.meta\.json$/, '.files/') + primary : metaPath.replace(/\.meta\.json$/, '.files');
}
