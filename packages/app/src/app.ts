import { renderTaskBanner } from "@renx/toolkit";

export const createAppOutput = (): string => {
  return renderTaskBanner("Ship ci");
};
