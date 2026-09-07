// @ts-check
/* Pure contracts used by the CRM preview controller. */

/**
 * @typedef {Object} PreviewFunction
 * @property {string} [path]
 * @property {unknown} [language]
 * @property {string[]} [mirrorFiles]
 * @property {string[]} [mirrorDirectories]
 */

/** @param {string | null | undefined} path */
function previewFileDescription(path) {
  if (!path) return null;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  if (/\.[a-z0-9]+$/i.test(last)) return { name: last, title: path };
  return { name: 'index.json', title: `${parts.slice(0, -1).join('/')}/index.json - one row inside it` };
}

/** @param {PreviewFunction[]} rows @param {string} path */
function findPreviewFunction(rows, path) {
  return rows.find((row) => row.path === path
    || (Array.isArray(row.mirrorFiles) && row.mirrorFiles.includes(path)));
}

/**
 * @param {PreviewFunction | null | undefined} row
 * @param {(language: unknown) => boolean} isDelugeLanguage
 */
function previewProjectFiles(row, isDelugeLanguage) {
  if (!row || isDelugeLanguage(row.language)) return [];
  return (row.mirrorFiles || []).filter((path) => !path.endsWith('.meta.json'));
}

/**
 * @param {PreviewFunction | null | undefined} row
 * @param {(language: unknown) => boolean} isDelugeLanguage
 */
function previewProjectDirectories(row, isDelugeLanguage) {
  if (!row || isDelugeLanguage(row.language)) return [];
  return row.mirrorDirectories || [];
}
