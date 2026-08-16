// An in-memory File System Access API, over a plain {path: text} map.
//
// It exists so the side panel can be **rendered** for a screenshot rather than captured from a
// running browser. Headless Chrome cannot be handed a folder - the permission is a user gesture by
// design - so without this there is no way to photograph the panel at all, and the images published
// so far were taken against the org this is developed on and then blurred.
//
// What it is and what it is not. The page is the shipped one, byte for byte: nothing in the panel
// knows this is here. So what the picture shows is what the panel does with those files. But this
// is an *approximation of an API*, not the API - it implements the calls the panels actually make
// (`showDirectoryPicker`, `getDirectoryHandle`, `getFileHandle`, `createWritable`, `removeEntry`,
// `values`, `entries`, `queryPermission`, `requestPermission`) and nothing else. If a panel starts
// using something new it will fail loudly here, which is the right direction: a screenshot that
// silently renders a state the real API would not produce would be worse than no screenshot.
//
// Writes are kept in memory and thrown away. Nothing on disk is touched.
(function () {
  const tree = {};   // path -> text
  // Instrumentation, because «is the panel slow» is a question about *how many* calls it makes as
  // much as about how long each one takes. A benchmark reads window.__zoostFsCalls; nothing in the
  // product knows this exists.
  const calls = { getFile: 0, getFileHandle: 0, getDirectoryHandle: 0, entries: 0, write: 0 };
  window.__zoostFsCalls = calls;

  // An index beside the tree, so a path costs a lookup rather than a scan.
  //
  // It did scan: `under()` and `isDir()` walked every key of the workspace on every call, which is
  // fine for the 293-file sample this was written for and quadratic on anything real. Benchmarking
  // the panel against a generated org of 5,000 functions, the load took forty seconds - and all of
  // it was *here*: 14,000 reads, each resolving two or three directory levels, each level walking
  // 10,000 keys. The panel was blamed twice before the instrument was measured, which is the whole
  // reason this comment is long: a slow tool does not look like a slow tool, it looks like a slow
  // product.
  const kids = new Map();     // directory -> Set of the names directly inside it
  const dirs = new Set();     // every directory that exists because something is under it
  const note = (path) => {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!kids.has(parent)) kids.set(parent, new Set());
      kids.get(parent).add(parts[i]);
      if (i < parts.length - 1) dirs.add(parts.slice(0, i + 1).join('/'));
    }
  };
  const forget = (path) => {           // rebuilt rather than unpicked: removal is rare and exact
    kids.clear(); dirs.clear();
    for (const k of Object.keys(tree)) note(k);
  };
  const norm = (p) => p.replace(/^\/+|\/+$/g, '');
  const under = (prefix) => [...(kids.get(norm(prefix || '')) || [])].sort();
  const isDir = (path) => dirs.has(norm(path));

  function fileHandle(path) {
    return {
      kind: 'file',
      name: path.split('/').pop(),
      async getFile() {
        calls.getFile++;
        if (!(path in tree)) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
        const text = tree[path];
        return { text: async () => text, size: text.length, name: path.split('/').pop() };
      },
      async createWritable() {
        return { write: async (c) => { calls.write++; tree[path] = String(c); note(path); }, close: async () => {} };
      },
    };
  }

  function dirHandle(path) {
    const self = {
      kind: 'directory',
      name: path ? path.split('/').pop() : 'sample',
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async getDirectoryHandle(name, opts) {
        calls.getDirectoryHandle++;
        const p = path ? path + '/' + name : name;
        if (!isDir(p) && !(opts && opts.create)) {
          throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
        }
        return dirHandle(p);
      },
      async getFileHandle(name, opts) {
        calls.getFileHandle++;
        const p = path ? path + '/' + name : name;
        if (!(p in tree)) {
          if (!(opts && opts.create)) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
          tree[p] = ''; note(p);
        }
        return fileHandle(p);
      },
      async removeEntry(name) {
        const p = path ? path + '/' + name : name;
        delete tree[p];
        for (const k of Object.keys(tree)) if (k.startsWith(p + '/')) delete tree[k];
        forget();
      },
      async *values() {
        for (const n of under(path)) {
          const p = path ? path + '/' + n : n;
          yield isDir(p) ? dirHandle(p) : fileHandle(p);
        }
      },
      async *entries() {
        calls.entries++;
        for (const n of under(path)) {
          const p = path ? path + '/' + n : n;
          yield [n, isDir(p) ? dirHandle(p) : fileHandle(p)];
        }
      },
    };
    return self;
  }

  // The panel keeps the folder handle in IndexedDB between sessions; here it is a plain object, so
  // the panel finds a folder already chosen and renders the state a returning user sees.
  const store = {};
  window.idbHandle = {
    get: async (k) => store[k],
    set: async (k, v) => { store[k] = v; },
    del: async (k) => { delete store[k]; },
  };

  window.showDirectoryPicker = async () => dirHandle('');
  window.__fsshim = {
    load(files) { Object.assign(tree, files); for (const k of Object.keys(files)) note(k); },
    clear() { for (const k of Object.keys(tree)) delete tree[k]; forget(); },
    root: () => dirHandle(''),
    dump: () => Object.keys(tree).sort(),
  };
})();
