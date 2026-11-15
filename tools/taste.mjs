// Taste-loop ranking and learning from scores.
// Ranks candidates by a weighted score of arrangement, mix and tune metrics,
// then can adjust future seeds or weights based on listener feedback.

export function rankCandidates(candidates, weights = { arrangement: 0.4, mix: 0.3, tune: 0.3 }) {
  return candidates.map(c => {
    const score = (c.arrangementAndMix ?? 50) * weights.arrangement
                + (100 + (c.integratedLufs ?? -16)) * weights.mix * 0.5
                + (c.tune ?? 50) * weights.tune;
    return { ...c, tasteScore: Math.round(score) };
  }).sort((a, b) => b.tasteScore - a.tasteScore);
}

export function learnFromScores(history, feedback) {
  // history: previous rankings; feedback: { preferred: id, rejected: id }
  // Returns adjusted weights that favour features of the preferred piece.
  const preferred = history.find(h => h.id === feedback.preferred);
  const rejected = history.find(h => h.id === feedback.rejected);
  if (!preferred || !rejected) return { arrangement: 0.4, mix: 0.3, tune: 0.3 };
  const delta = {
    arrangement: (preferred.arrangementAndMix ?? 50) - (rejected.arrangementAndMix ?? 50),
    mix: (preferred.integratedLufs ?? -16) - (rejected.integratedLufs ?? -16),
    tune: (preferred.tune ?? 50) - (rejected.tune ?? 50),
  };
  const total = Math.abs(delta.arrangement) + Math.abs(delta.mix) + Math.abs(delta.tune) || 1;
  return {
    arrangement: 0.4 + delta.arrangement / total * 0.1,
    mix: 0.3 + delta.mix / total * 0.1,
    tune: 0.3 + delta.tune / total * 0.1,
  };
}

export function register({ tool, z, moduleGuidance }) {
  moduleGuidance.push('rank_candidates re-ranks compose_batch results with adjustable weights. learn_from_scores adjusts weights from listener feedback (preferred vs rejected).');

  tool('rank_candidates', 'Re-rank a list of compose candidates with custom weights for arrangement, mix and tune. Returns sorted list with tasteScore.', {
    candidates: z.array(z.object({ id: z.string().optional(), arrangementAndMix: z.number().optional(), integratedLufs: z.number().optional(), tune: z.number().optional() })),
    weights: z.object({ arrangement: z.number().optional(), mix: z.number().optional(), tune: z.number().optional() }).optional(),
  }, async ({ candidates, weights }) => ({ ranking: rankCandidates(candidates, weights) }));

  tool('learn_from_scores', 'Adjust ranking weights from listener feedback (preferred vs rejected piece). Returns new weights for the next batch.', {
    history: z.array(z.any()),
    preferred: z.string(),
    rejected: z.string(),
  }, async ({ history, preferred, rejected }) => ({ weights: learnFromScores(history, { preferred, rejected }) }));
}
