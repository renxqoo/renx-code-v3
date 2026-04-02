import type { ContextBudgetSnapshot, ContextManagerConfig } from "./types";

export const buildBudgetSnapshot = (
  estimatedInputTokens: number,
  config: ContextManagerConfig,
): ContextBudgetSnapshot => {
  const warningBuffer =
    config.thresholds.warningBufferTokens ?? Math.floor(config.maxInputTokens * 0.2);
  const autoCompactBuffer =
    config.thresholds.autoCompactBufferTokens ?? Math.floor(config.maxInputTokens * 0.13);
  const errorBuffer = config.thresholds.errorBufferTokens ?? warningBuffer;
  const blockingHeadroom = config.thresholds.blockingHeadroomTokens ?? 3_000;

  const autoCompactThreshold = config.maxInputTokens - autoCompactBuffer;
  const thresholdBase = autoCompactThreshold;
  const warningThreshold = thresholdBase - warningBuffer;
  const errorThreshold = thresholdBase - errorBuffer;
  const blockingThreshold = config.maxInputTokens - blockingHeadroom;

  return {
    estimatedInputTokens,
    warningThreshold,
    autoCompactThreshold,
    errorThreshold,
    blockingThreshold,
    inWarning: estimatedInputTokens >= warningThreshold,
    requiresAutoCompact: estimatedInputTokens >= autoCompactThreshold,
    shouldBlock: estimatedInputTokens >= blockingThreshold,
  };
};
