/**
 * 电路与仿真之间的桥接：
 *   - 板级引脚变化 → 重新计算元件外观
 *   - 按键/电位器操作 → 向引擎注入电平或模拟量
 */

import { buttonInjection, potInjection } from "../circuit/behavior";
import { setApin } from "../lib/api";
import { behaviorInput, circuitStore, recompute } from "./circuitStore";
import { simStore, writePin } from "./simStore";
import { setMsg } from "./uiStore";

let inited = false;

/** 订阅引脚变化并完成一次初始计算（幂等） */
export function initCircuitBridge(): void {
  if (inited) return;
  inited = true;
  let prevPins = simStore.get().pins;
  simStore.subscribe(() => {
    const pins = simStore.get().pins;
    if (pins !== prevPins) {
      prevPins = pins;
      recompute();
    }
  });
  recompute();
}

/** 按下或松开画布上的按键：未接 GPIO 时只更新外观 */
export async function pressPart(partId: string, pressed: boolean): Promise<void> {
  circuitStore.set({ pressed: pressed ? partId : null });
  recompute();
  const injection = buttonInjection(behaviorInput(), partId, pressed);
  if (!injection) {
    if (pressed) setMsg("按键未连接到 GPIO 引脚，仅显示按下状态");
    return;
  }
  await writePin(injection.boardPin, injection.value);
}

/** 拖动电位器：把 0..1 位置换算成 ADC 读数注入 */
export async function changePot(partId: string, value01: number): Promise<void> {
  const value = Math.min(1, Math.max(0, value01));
  circuitStore.set((prev) => ({ potValues: { ...prev.potValues, [partId]: value } }));
  recompute();
  const injection = potInjection(behaviorInput(), partId, value);
  if (!injection) {
    setMsg("电位器 SIG 未接到支持 ADC 的引脚，模拟量无法注入");
    return;
  }
  try {
    await setApin(injection.channel, injection.raw);
  } catch (e) {
    setMsg(`模拟量注入失败: ${e}`);
  }
}
