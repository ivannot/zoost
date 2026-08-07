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

  const norm = (p) => p.replace(/^\/+|\/+$/g, '');
  const under = (prefix) => {
    const p = prefix ? norm(prefix) + '/' : '';
    const names = new Set();
    for (const k of Object.keys(tree)) {
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length);
      if (!rest) continue;
      names.add(rest.split('/')[0]);
    }
    return [...names].sort();
  };
  const isDir = (path) => Object.keys(tree).some((k) => k.startsWith(norm(path) + '/'));

  function fileHandle(path) {
    return {
      kind: 'file',
      name: path.split('/').pop(),
      async getFile() {
        if (!(path in tree)) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
        const text = tree[path];
        return { text: async () => text, size: text.length, name: path.split('/').pop() };
      },
      async createWritable() {
        return { write: async (c) => { tree[path] = String(c); }, close: async () => {} };
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
        const p = path ? path + '/' + name : name;
        if (!isDir(p) && !(opts && opts.create)) {
          throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
        }
        return dirHandle(p);
      },
      async getFileHandle(name, opts) {
        const p = path ? path + '/' + name : name;
        if (!(p in tree)) {
          if (!(opts && opts.create)) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
          tree[p] = '';
        }
        return fileHandle(p);
      },
      async removeEntry(name) {
        const p = path ? path + '/' + name : name;
        delete tree[p];
        for (const k of Object.keys(tree)) if (k.startsWith(p + '/')) delete tree[k];
      },
      async *values() {
        for (const n of under(path)) {
          const p = path ? path + '/' + n : n;
          yield isDir(p) ? dirHandle(p) : fileHandle(p);
        }
      },
      async *entries() {
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
    load(files) { Object.assign(tree, files); },
    clear() { for (const k of Object.keys(tree)) delete tree[k]; },
    root: () => dirHandle(''),
    dump: () => Object.keys(tree).sort(),
  };
})();
