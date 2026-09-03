// 切片公共件：StateCreator 类型别名与跨切片共享的小工具。
// 每个切片是 `StateCreator<AppStore, [], [], XSlice>`——全量 AppStore 进、
// 自己的一片出，组合后消费方接口不变

import type { StateCreator } from "zustand";
import type { AppStore } from "../../store";

export type Slice<T> = StateCreator<AppStore, [], [], T>;

// 模块求值时机不保证 DOM 全局就绪（vitest 4 模块执行器在被依赖模块求值后才装 jsdom 全局），
// 读 localStorage 一律走这里：非 DOM 上下文回落 null（= 默认值）
export function readStored(key: string): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
}
