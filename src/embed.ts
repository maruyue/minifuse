// 内嵌静态资源:UI bundle 以 text import 在编译期内联进二进制。
// 构建顺序见 package.json:先 build:ui 产出 dist/ui/main.js,再 compile。

// @ts-ignore -- bun text import(编译期内联)
import uiJs from "../dist/ui/main.js" with { type: "text" };

export function loadUiAssets(): { js: string; css: string } {
  return { js: uiJs, css: "" };
}
