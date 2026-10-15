// Checks the browser's value network (static/vnet.js, with the weights in
// static/nets/value.bin) against PyTorch: vnet.json has positions of games of
// each number of suits and the win probability PyTorch gives each
// (tools/analysis/export.py writes both files). Prints the largest
// difference for each number of suits and fails if one is over a thousandth,
// or if what the line player does next in a position (which the network is
// told) is not what src/vnet.rs made it when the file was written.
// The repository root's `cargo test` runs this.
import { readFileSync } from 'node:fs';
import { Net } from '../static/vnet.js';

const file = name => readFileSync(new URL(name, import.meta.url));
const bytes = file('../static/nets/value.bin'), all = JSON.parse(file('vnet.json'));
let bad = false;
for (let suits = 1; suits <= 4; suits++) {
  const net = new Net(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), suits);
  const samples = all.filter(s => s.suits === suits);
  let worst = 0;
  const t0 = performance.now();
  for (const { enc, p, next } of samples) { const e = Buffer.from(enc, "base64"); if (net.next(e) !== next) throw new Error(`next: ${net.next(e)} for ${next}`); worst = Math.max(worst, Math.abs(net.winProb(e) - p)); }
  const ms = (performance.now() - t0) / samples.length;
  console.log(`${suits} suits: ${samples.length} positions, largest difference ${worst.toExponential(2)}, ${ms.toFixed(1)} ms a position`);
  if (!(worst < 1e-3) || samples.length < 20) bad = true;
}
if (bad) process.exit(1);
