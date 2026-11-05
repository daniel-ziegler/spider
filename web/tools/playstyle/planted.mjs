import { analysisConfig } from '../../static/lineplayer.js';

// The synthetic players (T5): the line player with a flaw put in. `line` has none.
export function planted(suits) {
  const base = analysisConfig(suits);
  const change = c => ({ ...base, ...c, name: 'planted', staged: base.staged?.map(st => ({ ...st, ...c })) ?? null });
  return {
    short: change({ maxSteps: 2, beam: 0, expectTop: 0, replan: 0 }),
    emptyLow: change({ empty: Math.round(base.empty * 0.3), endEmpty: Math.round(base.endEmpty * 0.3) }),
    offHigh: change({ off: 10, offRank: 3 }),
    runLow: change({ runSq: 1 }),
  };
}
