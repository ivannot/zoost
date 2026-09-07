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

  function beginOperation() {
    const generation = options.generation();
    const root = options.root();
    const current = () => generation === options.generation() && root === options.root();
    const guard = () => { if (!current()) throw new Error(options.movedMessage); };
    async function through(work) {
      guard();
      const value = await work();
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
