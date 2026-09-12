import { describe, expect, it } from "vitest";
import {
  DEFAULT_FQBN,
  DEFAULT_PROJECT_NAME,
  PROJECT_VERSION,
  buildProjectFile,
  parseProjectFile,
  projectFileName,
  projectNameFromPath,
  sameProjectContent,
  touchRecent,
  type RecentEntry,
} from "../format";

const base = {
  name: "闪烁灯",
  code: "void setup() {}",
  diagram: '{"parts":[],"connections":[]}',
  sketchDir: "D:\\sk",
  fwDir: "D:\\fw",
  flashPath: "D:\\sk\\demo.bin",
};

describe("buildProjectFile", () => {
  it("填入版本号、默认 fqbn 与时间戳", () => {
    const p = buildProjectFile({ ...base, updatedAt: "2026-09-12T00:00:00.000Z" });
    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.fqbn).toBe(DEFAULT_FQBN);
    expect(p.updatedAt).toBe("2026-09-12T00:00:00.000Z");
    expect(p.name).toBe("闪烁灯");
  });

  it("空名称回落到默认名", () => {
    const p = buildProjectFile({ ...base, name: "", updatedAt: "x" });
    expect(p.name).toBe(DEFAULT_PROJECT_NAME);
  });
});

describe("projectNameFromPath", () => {
  it("取文件名并去掉扩展名", () => {
    expect(projectNameFromPath("D:\\work\\灯.fmp")).toBe("灯");
    expect(projectNameFromPath("/home/u/blink.fmp")).toBe("blink");
    expect(projectNameFromPath("D:\\work\\a.json")).toBe("a");
  });

  it("空路径回落到默认名", () => {
    expect(projectNameFromPath("")).toBe(DEFAULT_PROJECT_NAME);
  });
});

describe("projectFileName", () => {
  it("去掉非法字符并补扩展名", () => {
    // "a/b:c*?" → 连续的非法字符 "*?" 合并成一个下划线
    expect(projectFileName("a/b:c*?")).toBe("a_b_c_.fmp");
    expect(projectFileName("闪烁灯")).toBe("闪烁灯.fmp");
  });

  it("空名称回落到默认名", () => {
    expect(projectFileName("")).toBe(`${DEFAULT_PROJECT_NAME}.fmp`);
  });
});

describe("parseProjectFile", () => {
  it("解析自己写出的工程（往返一致）", () => {
    const original = buildProjectFile({ ...base, updatedAt: "2026-09-12T00:00:00.000Z" });
    const { project, errors } = parseProjectFile(JSON.stringify(original));
    expect(errors).toEqual([]);
    expect(project).not.toBeNull();
    expect(sameProjectContent(project!, original)).toBe(true);
  });

  it("非 JSON 文本给出可读错误", () => {
    const { project, errors } = parseProjectFile("not json");
    expect(project).toBeNull();
    expect(errors[0]).toContain("不是合法的 JSON");
  });

  it("缺字段但含 code 的文件按默认值补齐", () => {
    const { project, errors } = parseProjectFile('{"version":1,"code":"void loop(){}"}');
    expect(project).not.toBeNull();
    expect(project!.name).toBe(DEFAULT_PROJECT_NAME);
    expect(project!.fqbn).toBe(DEFAULT_FQBN);
    expect(project!.diagram).toBe("");
    expect(errors).toEqual([]);
  });

  it("既无 code 又无 diagram 时拒绝", () => {
    const { project, errors } = parseProjectFile('{"version":1}');
    expect(project).toBeNull();
    expect(errors.join(" ")).toContain("不是 FengtouMu 工程文件");
  });

  it("版本过新时拒绝并提示升级", () => {
    const { project, errors } = parseProjectFile(
      JSON.stringify({ version: PROJECT_VERSION + 1, code: "x" }),
    );
    expect(project).toBeNull();
    expect(errors.join(" ")).toContain("高于当前支持");
  });

  it("数组根节点不是工程文件", () => {
    const { project, errors } = parseProjectFile("[]");
    expect(project).toBeNull();
    expect(errors[0]).toContain("应为对象");
  });
});

describe("touchRecent", () => {
  const entry = (p: string, t: string): RecentEntry => ({ path: p, name: p, openedAt: t });

  it("新记录排在最前", () => {
    const list = touchRecent([entry("a", "1")], entry("b", "2"));
    expect(list.map((e) => e.path)).toEqual(["b", "a"]);
  });

  it("同路径去重（保留最新一次）", () => {
    const list = touchRecent([entry("a", "1"), entry("b", "2")], entry("a", "3"));
    expect(list.map((e) => e.path)).toEqual(["a", "b"]);
    expect(list[0].openedAt).toBe("3");
  });

  it("超出上限时截断", () => {
    const list = touchRecent([], entry("a", "1"), 2);
    const more = touchRecent(list, entry("b", "2"), 2);
    const evenMore = touchRecent(more, entry("c", "3"), 2);
    expect(evenMore.map((e) => e.path)).toEqual(["c", "b"]);
  });
});

describe("sameProjectContent", () => {
  it("只比较内容，不比较名称与时间", () => {
    const a = buildProjectFile({ ...base, updatedAt: "1" });
    const b = buildProjectFile({ ...base, name: "另一个名字", updatedAt: "2" });
    expect(sameProjectContent(a, b)).toBe(true);
  });

  it("源码不同则不等价", () => {
    const a = buildProjectFile({ ...base, updatedAt: "1" });
    const b = buildProjectFile({ ...base, code: "changed", updatedAt: "1" });
    expect(sameProjectContent(a, b)).toBe(false);
  });
});
