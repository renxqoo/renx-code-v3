export interface GlmModelPreset {
  id: string;
  provider: "glm";
  name: string;
  baseURL: string;
  endpointPath: string;
  model: string;
}

export const GLM_5_1_CODING_PLAN: GlmModelPreset = {
  id: "glm-5.1",
  provider: "glm",
  name: "GLM-5.1",
  baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
  endpointPath: "/chat/completions",
  model: "GLM-5.1",
};
