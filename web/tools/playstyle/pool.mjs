// A pool of worker threads taking one piece of work at a time.
import { Worker } from 'node:worker_threads';
export function runPool(url, n, items, onResult) {
  return new Promise((resolve, reject) => {
    let next = 0, live = n, done = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(url, { resourceLimits: { maxOldGenerationSizeMb: 6000, maxYoungGenerationSizeMb: 256 } });
      const feed = () => { if (next < items.length) w.postMessage(items[next++]); else { w.postMessage(null); if (--live === 0) resolve(done); } };
      w.on('message', m => {
        if (m.ready) return feed();
        done++;
        onResult(m, done, items.length);
        feed();
      });
      w.on('error', reject);
    }
  });
}
