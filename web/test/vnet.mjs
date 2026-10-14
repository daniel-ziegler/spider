// Checks the browser's value network (static/vnet.js, with the weights in
// static/nets) against PyTorch: vnet-N.json has positions of N-suit games and
// the win probability PyTorch gives each (tools/analysis/export.py writes
// both files). Prints the largest difference for each network and fails if
// one is over a thousandth. The repository root's `cargo test` runs this.
import { readFileSync } from 'node:fs';
import { Net } from '../static/vnet.js';

const file = name => readFileSync(new URL(name, import.meta.url));
let bad = false;
for (let suits = 1; suits <= 4; suits++) {
  const bytes = file(`../static/nets/v${suits}.bin`);
  const net = new Net(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const samples = JSON.parse(file(`vnet-${suits}.json`));
  let worst = 0;
  const t0 = performance.now();
  for (const { enc, p } of samples) worst = Math.max(worst, Math.abs(net.winProb(Buffer.from(enc, 'base64')) - p));
  const ms = (performance.now() - t0) / samples.length;
  console.log(`${suits} suits: ${samples.length} positions, largest difference ${worst.toExponential(2)}, ${ms.toFixed(1)} ms a position`);
  if (!(worst < 1e-3) || samples.length < 20) bad = true;
}
if (bad) process.exit(1);
