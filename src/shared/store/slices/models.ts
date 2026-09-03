// 模型配置切片：配置加载状态跨页保留（编辑草稿在 ModelsView 本地）

import * as cmd from "../../commands";
import type { ModelConfig } from "../../types";
import type { Slice } from "./shared";

export interface ModelSlice {
  modelConfigBusy: boolean;
  loadModelConfig: () => Promise<ModelConfig>;
}

export const createModelSlice: Slice<ModelSlice> = (set, get) => ({
  modelConfigBusy: false,
  loadModelConfig: async () => {
    if (get().modelConfigBusy) return await cmd.modelConfigLoad();
    set({ modelConfigBusy: true });
    try {
      return await cmd.modelConfigLoad();
    } finally {
      set({ modelConfigBusy: false });
    }
  },
});
