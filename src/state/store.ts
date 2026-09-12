/**
 * 极简状态容器：不引入额外依赖，供各业务域共享状态使用。
 *
 * 选择器返回值需要是基本类型或稳定引用（例如状态里保存的 Map/数组本身），
 * 否则 useSyncExternalStore 会因为每次返回新对象而反复渲染。
 */

import { useSyncExternalStore } from "react";

export interface Store<T extends object> {
  get: () => T;
  set: (patch: Partial<T> | ((state: T) => Partial<T>)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}

/** 为某个域创建一个带动作导出的小型 store 工厂 */
export function createDomain<T extends object>(
  initial: T,
): { store: Store<T>; patch: (p: Partial<T> | ((s: T) => Partial<T>)) => void } {
  const store = createStore(initial);
  return { store, patch: store.set };
}
