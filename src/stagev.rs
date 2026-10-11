//! The fitted value of a position the line player is about to deal from:
//! the chance that it goes on to win, by logistic regression on visible
//! features, one model per number of deals left (`runs/stage/fit.py`).
use crate::game::{Game, NUM_COLS};
use std::sync::OnceLock;

pub const FEATURES: [&str; 24] = [
    "completed", "hidden", "hidden_sq", "min_hidden", "clear", "low", "empty", "same", "off", "off_rank", "wrong", "pieces", "run_sq", "max_run",
    "ranks", "king_up", "ace_top", "king_top", "dig", "junk", "clear_cards", "clear_pieces", "face_up", "top_acc",
];

/// Visible features of a position.
pub fn features(g: &Game) -> [f64; 24] {
    let mut f = [0f64; 24];
    f[0] = g.completed.len() as f64;
    let mut min_hidden = 99usize;
    let mut top_ranks = 0u16;
    let mut tops = [0u8; 13];
    let mut heads: Vec<u8> = Vec::new();
    let mut max_run = 0;
    for c in 0..NUM_COLS {
        let col = &g.columns[c];
        let d = g.face_down[c];
        if col.is_empty() {
            f[6] += 1.0;
            continue;
        }
        f[1] += d as f64;
        f[2] += (d * d) as f64 / 16.0;
        min_hidden = min_hidden.min(d);
        if d == 0 {
            f[4] += 1.0;
            f[20] += col.len() as f64;
        }
        if d <= 1 {
            f[5] += 1.0;
        }
        f[22] += (col.len() - d) as f64;
        let top = col[col.len() - 1];
        if top.rank() != 0 {
            top_ranks |= 1 << top.rank();
        } else {
            f[16] += 1.0;
        }
        if top.rank() == 12 && col.len() > 1 {
            f[17] += 1.0;
        }
        tops[top.rank() as usize] += 1;
        let mut run = 1;
        let mut seq = true;
        let mut pieces = 1;
        for i in d + 1..col.len() {
            let (upper, lower) = (col[i - 1], col[i]);
            if lower.rank() == 12 {
                f[15] += 1.0;
            }
            if upper.rank() == lower.rank() + 1 {
                if upper.suit() == lower.suit() {
                    f[7] += 1.0;
                    run += 1;
                    continue;
                }
                f[8] += 1.0;
                f[9] += lower.rank() as f64 / 4.0;
            } else {
                f[10] += 1.0;
                seq = false;
                if d > 0 {
                    f[19] += 1.0;
                }
            }
            f[12] += (run * run) as f64 / 16.0;
            max_run = max_run.max(run);
            pieces += 1;
            run = 1;
        }
        f[12] += (run * run) as f64 / 16.0;
        max_run = max_run.max(run);
        f[11] += pieces as f64;
        if d == 0 {
            f[21] += pieces as f64;
        }
        if d > 0 && seq {
            f[18] += 1.0;
            heads.push(col[d].rank());
        }
    }
    f[3] = if min_hidden == 99 { 0.0 } else { min_hidden as f64 };
    f[13] = max_run as f64;
    f[14] = top_ranks.count_ones() as f64;
    // Columns that are one sequence over face-down cards and have a top
    // card to go to.
    f[23] = heads.iter().filter(|&&r| r < 12 && tops[r as usize + 1] > 0).count() as f64;
    f
}


/// Per deals left (index): feature means, standard deviations and weights
/// (the first the constant).
type Model = Vec<Option<(Vec<f64>, Vec<f64>, Vec<f64>)>>;

static MODEL: OnceLock<Model> = OnceLock::new();

/// The model in the file `SPIDER_V_MODEL` (a line per number of deals
/// left: it, then the means, the deviations and the weights).
fn model() -> &'static Model {
    MODEL.get_or_init(|| {
        let path = std::env::var("SPIDER_V_MODEL").expect("SPIDER_V_MODEL");
        let mut m: Model = vec![None; 6];
        for line in std::fs::read_to_string(path).expect("model file").lines() {
            let x: Vec<f64> = line.split_whitespace().map(|t| t.parse().unwrap()).collect();
            let n = FEATURES.len();
            m[x[0] as usize] = Some((x[1..1 + n].to_vec(), x[1 + n..1 + 2 * n].to_vec(), x[1 + 2 * n..].to_vec()));
        }
        m
    })
}

/// The chance of winning from `g`, about to deal.
pub fn deal_value(g: &Game) -> f64 {
    let (mu, sd, w) = model()[g.deals_remaining()].as_ref().expect("a model for this stage");
    let f = features(g);
    let z = w[0] + (0..f.len()).map(|i| w[1 + i] * (f[i] - mu[i]) / sd[i]).sum::<f64>();
    1.0 / (1.0 + (-z).exp())
}
