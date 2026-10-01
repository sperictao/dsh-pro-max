// 模型配置切片：配置加载状态跨页保留（编辑草稿在 ModelsView 本地）

import * as cmd from "../../commands";
import type { DshSurface, ModelConfig } from "../../types";
import type { Slice } from "./shared";

export interface ModelSlice {
  modelConfigBusy: boolean;
  // 按目标形态读模型域：web 档读 profile 补丁，desktop 档经桥接读应用的 Config Editor
  loadModelConfig: (surface: DshSurface) => Promise<ModelConfig>;
}

export const createModelSlice: Slice<ModelSlice> = (set, get) => ({
  modelConfigBusy: false,
  loadModelConfig: async (surface) => {
    if (get().modelConfigBusy) return await cmd.modelConfigLoad(surface);
    set({ modelConfigBusy: true });
    try {
      return await cmd.modelConfigLoad(surface);
    } finally {
      set({ modelConfigBusy: false });
    }
  },
});
