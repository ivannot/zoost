// @ts-check
/* File System Access adapter for one workspace.
 *
 * The panel owns which workspace is current and what a write invalidates. This adapter owns folder
 * permissions, directory-handle caching and the operation guard that checks identity on both sides
 * of every asynchronous filesystem act.
 */

/** @typedef {{
 * root: () => any,
 * generation: () => number,
 * onWrite: (path: string) => void,
 * say: (text: string, kind?: string) => void,
 * folderMessage: string,
 * movedMessage: string,
 * permissionLost?: () => void,
 * }} WorkspaceFilesystemOptions */

/** @param {WorkspaceFilesystemOptions} options */
function createWorkspaceFilesystem(options) {
  let directoryCaches = new WeakMap();

  async function ensurePermission(handle) {
    const request = { mode: 'readwrite' };
    if ((await handle.queryPermission(request)) === 'granted') return true;
    return (await handle.requestPermission(request)) === 'granted';
  }

  async function hasPermission(handle) {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  }

  async function requirePermission(handle) {
    if (!(await ensurePermission(handle))) throw new Error(options.folderMessage);
  }

  function forgetDirectories(root) {
    if (root) directoryCaches.delete(root);
    else directoryCaches = new WeakMap();
  }

  async function directoryFor(parts, create, root = options.root()) {
    if (!root) throw new Error('No workspace folder is open.');
    let cache = directoryCaches.get(root);
    if (!cache) directoryCaches.set(root, (cache = new Map()));
    const key = parts.join('/');
    if (cache.has(key)) return cache.get(key);
    let directory = root;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, create ? { create: true } : undefined);
    }
    cache.set(key, directory);
    return directory;
  }

  function assertCurrentRoot(root) {
    if (root !== options.root()) throw new Error(options.movedMessage);
  }

  async function ensureDirectoryAt(root, relativePath) {
    assertCurrentRoot(root);
    await directoryFor(relativePath.split('/').filter(Boolean), true, root);
  }

  async function writeFileAt(root, relativePath, content) {
    assertCurrentRoot(root);
    const parts = relativePath.split('/');
    const directory = await directoryFor(parts.slice(0, -1), true, root);
    const handle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    options.onWrite(relativePath);
  }

  async function readFileAt(root, relativePath) {
    const parts = relativePath.split('/');
    const directory = await directoryFor(parts.slice(0, -1), false, root);
    const handle = await directory.getFileHandle(parts[parts.length - 1]);
    return (await handle.getFile()).text();
  }

  async function removeFileAt(root, relativePath) {
    assertCurrentRoot(root);
    const parts = relativePath.split('/');
    const name = parts.pop();
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    await directory.removeEntry(name);
    options.onWrite(relativePath);
  }

  /** A refused read is a question, not a diagnosis.
   *
   * A folder grant can lapse while the panel is open, and nothing tells the page it has: every read
   * simply starts refusing. The panel remembered the answer it got when the workspace was opened,
   * so it went on believing it had access - which switched off both remedies it advertises, since
   * «click anywhere to re-grant» and «↻ Refresh» are gated on that same remembered flag. The reader
   * was then told six local files were damaged, and offered a pull that could not have worked
   * either.
   *
   * So the grant is **re-derived from the event**: any failed operation asks the API whether the
   * permission is still there, and a «no» is reported once to whoever owns that state. The question
   * is asked rather than the exception read - which error a lapsed grant throws is Chrome's business
   * and not something this file should encode.
   *
   * What it does not cover, stated: only work driven through an operation. A direct `readFileAt` is
   * not watched, and neither is an enumeration.
   */
  async function askWhetherGrantIsGone() {
    const handle = options.root();
    if (!handle || !options.permissionLost) return;
    try { if (!(await hasPermission(handle))) options.permissionLost(); } catch (_) {}
  }

  function beginOperation() {
    const generation = options.generation();
    const root = options.root();
    const current = () => generation === options.generation() && root === options.root();
    const guard = () => { if (!current()) throw new Error(options.movedMessage); };
    async function through(work) {
      guard();
      let value;
      try { value = await work(); }
      catch (error) { await askWhetherGrantIsGone(); throw error; }
      guard();
      return value;
    }
    return {
      root,
      gen: generation,
      current,
      read: (path) => through(() => readFileAt(root, path)),
      write: (path, body) => through(() => writeFileAt(root, path, body)),
      mkdir: (path) => through(() => ensureDirectoryAt(root, path)),
      remove: (path) => through(() => removeFileAt(root, path)),
      say: (text, kind) => { if (current()) options.say(text, kind); },
    };
  }

  return {
    ensurePermission, hasPermission, requirePermission, forgetDirectories, directoryFor,
    beginOperation, ensureDirectoryAt, writeFileAt, readFileAt, removeFileAt,
  };
}
