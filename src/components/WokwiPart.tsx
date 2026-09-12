/**
 * 在 SVG 画布中渲染一个 wokwi 元件原图。
 *
 * 用法：放在某个已平移/缩放的 <g> 内，按元件类型 + 视觉状态渲染。
 * 每次状态变化会取回 wokwi 元素 shadow DOM 里的 <svg> 并替换（克隆，不携带
 * wokwi 元素自身的事件处理器，因此画布的连线/拖拽/按下等交互不受影响）。
 */

import { useEffect, useRef } from "react";
import { applyWokwiState, wokwiElement, wokwiSvgClone } from "../circuit/wokwi";
import type { PartType } from "../circuit/types";

interface Props {
  type: PartType;
  /** 视觉状态（与 behavior.ts 的 PartVisual 对应，仅外观用） */
  state: unknown;
}

export default function WokwiPart({ type, state }: Props) {
  const ref = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    let cancelled = false;
    const el = wokwiElement(type);
    applyWokwiState(type, el, state);
    wokwiSvgClone(type, el)
      .then((svg) => {
        if (cancelled || !g || !svg) return;
        g.replaceChildren();
        g.appendChild(svg);
      })
      .catch(() => {
        /* 个别元件在极端状态下渲染失败时保持空白即可 */
      });
    return () => {
      cancelled = true;
    };
  }, [type, state]);

  return <g ref={ref} className="wokwi-art" />;
}
