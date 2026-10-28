/**
 * Route-level lazy loader for below-the-fold feature modules.
 *
 * Why not static imports in app.js: the entry used to pull reader (13.6KB gzip),
 * prompts and upload before the first screen even painted. They are now fetched
 * on the route/interaction that actually needs them, and the SW precaches every
 * chunk so the lazy path still works offline.
 *
 * The promise is cached (not the module value) so two quick navigations cannot
 * run init twice; a failed import drops the cache entry and can be retried.
 */
const LOADERS = {
    reader: () => import('./reader.js').then((m) => m.initReader),
    prompts: () => import('./prompts.js').then((m) => m.initPrompts),
    upload: () => import('./upload.js').then((m) => m.initUpload),
};

const pending = new Map();
const ready = new Set();

export function isFeatureReady(name) {
    return ready.has(name);
}

export function loadFeature(name) {
    const loader = LOADERS[name];
    if (!loader) return Promise.reject(new Error('Unknown feature: ' + name));
    if (ready.has(name)) return Promise.resolve();
    if (!pending.has(name)) {
        const task = Promise.resolve()
            .then(loader)
            .then((init) => {
                const result = init();
                return result && typeof result.then === 'function' ? result : undefined;
            })
            .then(() => { ready.add(name); })
            .catch((err) => {
                pending.delete(name);
                throw err;
            });
        pending.set(name, task);
    }
    return pending.get(name);
}
