# DearOreUI 设计器

基于 **Tauri + Vite** 的离线可视化设计工具，用于预览和调试 **DearOreUI** 模组声明的 OreUI 界面。

![运行时界面](./public/runtime.png)

## 核心能力

- **模组 UI 自动识别（源码扫描）**：选择模组源码目录后，扫描 `registerComponent` 注册，自动识别其中的 UI 页面（含 `DomNode` body 与 `ComponentSpec` 组合树），**模组无需任何改动**。
- **离线预览**：不运行游戏即可在画布上渲染识别到的 UI；支持导入原版 `data/gui/dist/hbui` 资源做本地贴图预览（计划中）。
- **双加载模型**：独立模组入口、以及"原版屏幕 + 模组覆盖层"组合预览。
- **侧边标签页**：只展示模组改动/识别出的页面。

## 运行

获取最新发布的安装包 [下载链接](https://github.com/copper-lamp/DearOreUI-dev-tools/releases)
安装应用后，启动桌面应用即可使用

## 使用

1. 启动桌面应用。
2. 顶部菜单 **项目 → 打开模组目录**，选择目标模组源码目录（例如 `dearoreui-ExampleMod`）。
3. 左侧标签页列出自动识别出的 UI，点击即可在画布预览。
4. 通过 **项目 → 导入原版资源** 可导入原版 UI 资源用于更贴近真机的显示。（计划中）

## 技术栈

| 层     | 技术                                                                     |
| ----- | ---------------------------------------------------------------------- |
| 桌面宿主  | Tauri 2                                                                |
| 前端    | Vite + TypeScript                                                      |
| UI 渲染 | OracleUI (Coherent Gameface) 近似渲染，复用核心层 `stage7` 脚本与节点格式 `{t,s,x,a,c}` |
| 扫描    | `src-tauri/src/mod_scanner.rs`（静态分析 C++ 源码，纯只读）                        |

## 相关仓库

- 核心运行时：[DearOreUI](https://github.com/copper-lamp/Dear-OreUI)
- 示例模组：[dearoreui-ExampleMod](https://github.com/magicobs0z/dearoreui-ExampleMod)
