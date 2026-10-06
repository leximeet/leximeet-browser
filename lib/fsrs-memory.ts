import { FSRS_WEIGHTS } from "./fsrs-profile.ts";

export type RecallGrade = 1 | 2 | 3 | 4;
export type MemoryEstimate = { stability: number; difficulty: number };

/**
 * 按 FSRS 官方公开公式组织的纯数学层，不包含第三方调度器程序。
 * 公式来源：https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
 * 本仓 profile 的参数、同日 Hard 规则与精度以跨端黄金向量为准。
 */
const weights = FSRS_WEIGHTS;
const minimumStability = 0.001;
const decayExponent = -weights[20];
const curveFactor = 0.9 ** (1 / decayExponent) - 1;
const boundDifficulty = (value: number) => Math.max(1, Math.min(10, value));
const boundStability = (value: number) => Math.max(minimumStability, value);

// D₀(G)：第一次评价的难度。后续难度会向 Easy 的初始难度回归。
function startingDifficulty(grade: RecallGrade) {
  return boundDifficulty(weights[4] + 1 - Math.exp(weights[5] * (grade - 1)));
}

// R(t,S)：t 使用完整经过天数，S 表示回忆概率降到90%时的天数。
export function recallProbability(elapsedDays: number, stability: number) {
  return (1 + (curveFactor * elapsedDays) / stability) ** decayExponent;
}

// D′：先按距难度上限的余量阻尼，再向 D₀(Easy) 回归。
function updatedDifficulty(previous: number, grade: RecallGrade) {
  const difficultyChange = (-weights[6] * (grade - 3) * (10 - previous)) / 9;
  const reverted =
    weights[7] * startingDifficulty(4) + (1 - weights[7]) * (previous + difficultyChange);
  return boundDifficulty(reverted);
}

// S′：完整天数为0时应用短期记忆式；不把分钟差换成小数天。
function shortTermStability(previous: number, grade: RecallGrade) {
  const growth =
    Math.exp(weights[17] * (grade - 3 + weights[18])) * previous ** -weights[19];
  // 固定 profile 在 Good/Easy 时保护 S 不下降。Hard 允许下降，是既有向量的明确约束。
  const protectedGrowth = grade > 2 ? Math.max(1, growth) : growth;
  return boundStability(previous * protectedGrowth);
}

// S′f：遗忘后重新建立记忆，不超过旧记忆经短期保护上限约束后的值。
function forgottenStability(memory: MemoryEstimate, probability: number) {
  const difficultyFactor = memory.difficulty ** -weights[12];
  const stabilityFactor = (memory.stability + 1) ** weights[13] - 1;
  const forgettingFactor = Math.exp(weights[14] * (1 - probability));
  const estimate = weights[11] * difficultyFactor * stabilityFactor * forgettingFactor;
  const ceiling = memory.stability / Math.exp(weights[17] * weights[18]);
  return boundStability(Math.min(estimate, ceiling));
}

// S′r：长期回忆后的增长；Hard 和 Easy 分别带有惩罚和奖励系数。
function rememberedStability(
  memory: MemoryEstimate,
  probability: number,
  grade: RecallGrade,
) {
  const gradeFactor = grade === 2 ? weights[15] : grade === 4 ? weights[16] : 1;
  const difficultyFactor = 11 - memory.difficulty;
  const stabilityFactor = memory.stability ** -weights[9];
  const recallFactor = Math.exp(weights[10] * (1 - probability)) - 1;
  const growth =
    Math.exp(weights[8]) *
    difficultyFactor *
    stabilityFactor *
    recallFactor *
    gradeFactor;
  return boundStability(memory.stability * (1 + growth));
}

/**
 * 输入只有记忆估计、评价与完整天数，输出只有新的 S/D。
 * 保留 JavaScript 浮点精度；统一 profile 不允许在每个中间步骤 round8。
 */
export function estimateMemory(
  previous: MemoryEstimate | null,
  grade: RecallGrade,
  elapsedDays: number,
): MemoryEstimate {
  if (!previous)
    return {
      stability: boundStability(weights[grade - 1]!),
      difficulty: startingDifficulty(grade),
    };
  const probability = recallProbability(elapsedDays, previous.stability);
  const stability =
    elapsedDays === 0
      ? shortTermStability(previous.stability, grade)
      : grade === 1
        ? forgottenStability(previous, probability)
        : rememberedStability(previous, probability, grade);
  return { stability, difficulty: updatedDifficulty(previous.difficulty, grade) };
}
