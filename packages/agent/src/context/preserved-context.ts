import type { ContextRuntimeState, PreservedContextAsset } from "./types";

export const registerPreservedContextAsset = (
  state: ContextRuntimeState,
  asset: Omit<PreservedContextAsset, "updatedAt"> & { updatedAt?: string },
): ContextRuntimeState => {
  const normalized: PreservedContextAsset = {
    ...asset,
    updatedAt: asset.updatedAt ?? new Date().toISOString(),
  };
  return {
    ...state,
    preservedContextAssets: {
      ...(state.preservedContextAssets ?? {}),
      [normalized.id]: normalized,
    },
  };
};

export const removePreservedContextAsset = (
  state: ContextRuntimeState,
  assetId: string,
): ContextRuntimeState => {
  const current = state.preservedContextAssets ?? {};
  const { [assetId]: _removed, ...rest } = current;
  return {
    ...state,
    preservedContextAssets: rest,
  };
};

export const listPreservedContextAssets = (state: ContextRuntimeState): PreservedContextAsset[] =>
  Object.values(state.preservedContextAssets ?? {}).sort((left, right) => {
    const priorityDiff = (right.priority ?? 0) - (left.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
