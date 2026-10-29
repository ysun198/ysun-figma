# Find a native capability

Use `figma_api(query="需求或 API 名称")` before inventing a workaround. An exact MCP tool name, such as `figma_design_context`, also returns its current installed input/output contract directly from the tool definition. These tables are the single task index used by the tool, its topic enum and the reference checker. Search phrases route tasks; exact declarations come from the pinned official types. Neither establishes account permission. These instructions describe mechanics, not a design style.

## Topics

| Id | Guide | Scope | Workflows |
| --- | --- | --- | --- |
| `overview` | [api-map.md](api-map.md) | Task index, editor modes and local/remote differences | inspect, create, edit |
| `layout` | [layout.md](layout.md) | Coordinates, transforms, Auto Layout, wrapping and grids | create, edit |
| `text` | [text-images.md](text-images.md) | Fonts, mixed text, text paths and image import | create, edit |
| `paint` | [paint-effects.md](paint-effects.md) | Color spaces, gradients, fills, strokes and effects | create, edit |
| `vectors` | [vectors.md](vectors.md) | Vector networks, tangents, booleans, masks and geometry | create, edit |
| `components` | [components-variables.md](components-variables.md) | Components, instances, variants, variables and styles | system, edit |
| `motion` | [motion.md](motion.md) | Keyframes, easing, animation styles and text motion | motion |
| `figjam` | [figjam.md](figjam.md) | Editable shapes, connectors, stickies and tables | create, edit |
| `slides` | [slides.md](slides.md) | Slides, rows, grids and editor boundaries | create, edit |
| `handoff` | [handoff.md](handoff.md) | CSS, Dev Resources, SwiftUI and Code Connect | handoff |
| `prototype` | [prototype skill](../../ysun-figma-prototype/SKILL.md) | Reactions, overlays and interaction verification | prototype |
| `files` | [files skill](../../ysun-figma-files/SKILL.md) | Exact file identity, connection and version checkpoints | connect |
| `shaders` | [shaders.md](shaders.md) | Native shader discovery and application | edit |
| `community` | [community.md](community.md) | Read-only public Community research | research |
| `execution` | [native-execution.md](native-execution.md) | Scripts, assets, receipts, exports and recovery | inspect, edit, export, conflict, uncertain, delivery |
| `cloud` | [capabilities.md](capabilities.md) | Official workflow comparison and separate cloud services | connect |


## Workflows

Choose by the intended result. Tool lists are a shortlist, not a required sequence; the guide selects the write boundary and ordering. Skip steps whose evidence is already current. Do not substitute keyframes for click interactions or repeat a native edit to repair export delivery.

| Id | When | Tool shortlist | Guide |
| --- | --- | --- | --- |
| `inspect` | Read/search a design without changing it; inspect structure or original assets | figma_status, figma_inspect, figma_find_nodes, figma_design_context, figma_download_assets | [inspect](native-execution.md) |
| `create` | Build new editable content, a screen, FigJam board or Slides deck | figma_status, figma_api, figma_capabilities, figma_run, figma_export_node | [create](../../ysun-figma-create-design/SKILL.md) |
| `edit` | Change existing content or work alongside other tasks; use one coherent native edit, or snapshot dependencies when a decision spans calls | figma_status, figma_inspect, figma_snapshot, figma_run, figma_inspect | [conditional edits](concurrency.md) |
| `motion` | Animate properties over time, read tracks or implement an existing animation | figma_status, figma_motion, figma_api, figma_capabilities, figma_snapshot, figma_run, figma_motion, figma_export_node | [motion](motion.md) |
| `prototype` | Make a click, hover, navigation, state change or overlay interaction | figma_status, figma_design_context, figma_snapshot, figma_run, figma_design_context | [prototype](../../ysun-figma-prototype/SKILL.md) |
| `system` | Create/change variables, modes, shared styles, components or variants | figma_status, figma_design_system, figma_components, figma_snapshot, figma_run, figma_design_system | [design system](../../ysun-figma-design-system/SKILL.md) |
| `handoff` | Implement a Figma design in repository code or map components with Code Connect | figma_status, figma_design_context, figma_components, figma_motion, figma_download_assets | [handoff](handoff.md) |
| `export` | Render nodes to images/video or download original assets | figma_status, figma_export_node, figma_export | [exports](native-execution.md) |
| `research` | Find public Community references; no design-file connection needed | figma_community | [Community](community.md) |
| `connect` | Find/open/connect the exact file or recover a native plugin update; cloud creation is separate | figma_status, figma_file, figma_connect | [files](../../ysun-figma-files/SKILL.md) |
| `conflict` | FIGMA_WRITE_CONFLICT: the conditional body did not run; re-read and merge the latest values | figma_snapshot, figma_run | [conflict](concurrency.md) |
| `uncertain` | Lost response, interruption or partial write: read original receipt before any new write | figma_job, figma_inspect, figma_reconcile | [uncertain outcome](native-execution.md) |
| `delivery` | Native operation succeeded but exporting/saving its output failed; reuse original result | figma_job, figma_export | [delivery](native-execution.md) |

## Features

The first phrase names the task; semicolons separate search phrases. Symbol lists name native declarations or existing MCP tools, not executable recipes. Follow the topic for required ordering and editor constraints.

| Topic | Task / search phrases | Native symbols / tools |
| --- | --- | --- |
| `files` | File identity; 文件身份; 文件连接; 打开文件; file connection | figma_status, figma_file |
| `files` | Version checkpoint; 版本历史; 检查点; 备份; 保存版本; backup; version history | saveVersionHistoryAsync, commitUndo, figma_file |
| `execution` | Page and viewport; 切换页面; 选择图层; 缩放视口; navigate; viewport | figma_navigate, setCurrentPageAsync, scrollAndZoomIntoView |
| `execution` | Inspect and find; 查找图层; 读取结构; 搜索节点; inspect; find nodes | figma_inspect, figma_find_nodes, findAllWithCriteria |
| `execution` | Workbench preview; 打开工作台; 账号文件浏览; sidebar preview | figma_open, figma_watch, figma_canvas |
| `execution` | Quick screenshot; 快速截图; 单个节点预览; inline screenshot | figma_screenshot |
| `layout` | Auto Layout; 自动布局; 响应式; 随内容伸缩; 自适应内容; 文案长短; auto layout; hug; fill container | layoutMode, primaryAxisSizingMode, layoutSizingHorizontal, layoutSizingVertical |
| `layout` | Grid and wrapping; 网格; 栅格; 自动换行; grid; wrap | layoutGrids, gridColumnCount, gridRowCount, layoutWrap |
| `layout` | Coordinates and reparenting; 坐标; 透视变换; 重新挂载; reparent; transform | relativeTransform, absoluteTransform, appendChild, rescale |
| `layout` | Constraints and stacking; 约束; 层级; 叠放; constraints; stacking | constraints, insertChild, clipsContent |
| `text` | Load fonts; 加载字体; 字体缺失; font loading | listAvailableFontsAsync, loadFontAsync, hasMissingFont |
| `text` | Mixed text and links; 富文本; 混合字体; 超链接; mixed text; hyperlink | getStyledTextSegments, setRangeFontName, setRangeHyperlink |
| `text` | Variable fonts; 可变字体; 字重轴; variable font | FontNameInput, variationSettings, getFontFamilyVariationAxes |
| `text` | Text on a path; 沿路径; 路径文字; 弧形文字; 环绕文字; 沿着圆; text on path; curved text; follow a curve | createTextPath, TextPathNode |
| `text` | Text resizing; 文本换行; 文字自适应; text resize | textAutoResize, lineHeight, letterSpacing |
| `paint` | Color spaces; 色彩空间; 广色域; 原始颜色; OKLCH; Display P3; color space | ColorWithColorSpace, RGBWithColorSpace, RGBAWithColorSpace, sourceColor, rgb, rgba, solidPaint |
| `paint` | Fills and gradients; 填充; 渐变; gradient; fill paint | Paint, SolidPaint, GradientPaint, gradientTransform |
| `paint` | Effects and blending; 阴影; 模糊; 混合模式; shadow; blur; blend | Effect, effects, blendMode |
| `text` | Images and cropping; 图片裁剪; 图片填充; 原图; image crop; image fill | figma_upload_assets, createImage, ImagePaint, imageTransform |
| `paint` | Video and GIF; 视频填充; 导入视频; 动图; video fill; animated gif | createVideoAsync, VideoPaint, createGif |
| `vectors` | Vector networks; 连接处; 路径节点; 切线; 矢量网络; vector network; tangent | setVectorNetworkAsync, VectorNetwork, VectorVertex, VectorSegment |
| `vectors` | Stroke geometry; 描边; 线帽; 拐角; 圆角; stroke; corner | strokeWeight, strokeJoin, strokeCap, cornerSmoothing |
| `vectors` | Brushes; 笔刷; 画笔; brush | loadBrushesAsync, VectorPath, BrushStrokeProperties |
| `vectors` | Boolean operations; 布尔运算; 联集; 差集; 交集; boolean | union, subtract, intersect, exclude, flatten |
| `vectors` | Masks and clipping; 蒙版; 遮罩; 裁剪内容; mask; clipping | isMask, maskType, clipsContent |
| `vectors` | SVG import; 导入SVG; 导入矢量; svg import | createNodeFromSvg, figma_upload_assets |
| `components` | Components and variants; 组件; 变体; component; variant | createComponentFromNode, combineAsVariants, ComponentSetNode |
| `components` | Component properties; 组件属性; 实例交换; component property | componentPropertyDefinitions, addComponentProperty, setProperties, preferredValues |
| `components` | Native slots; 插槽; 槽位; 可编辑内容区域; slot content | createSlot, SlotNode, SlotSettings, resetSlot |
| `components` | Instance overrides; 实例覆盖; 替换组件; instance override; swap | getMainComponentAsync, swapComponent, resetOverrides, detachInstance |
| `components` | Library imports; 导入组件库; 库变量; library import | importComponentByKeyAsync, importComponentSetByKeyAsync, getAvailableLibraryVariableCollectionsAsync |
| `components` | Variables and aliases; 变量; 别名; 设计令牌; 更换配色; 全部同步; 主题切换; token; variable alias | createVariable, createVariableCollection, createVariableAlias, setBoundVariable |
| `components` | Read variable values; 读取变量值; 列出模式; inspect variables | figma_variables |
| `components` | Modes and bindings; 多主题; 变量模式; 变量绑定; variable mode; binding | setExplicitVariableModeForCollection, setBoundVariableForPaint, setBoundVariableForEffect |
| `components` | Composed colors; 组合颜色; 颜色透明度变量; composed color | VariableComposedColor, VariableScope, COLOR_OPACITY |
| `components` | Shared styles; 共享样式; 文本样式; 效果样式; shared style | createTextStyle, createPaintStyle, createEffectStyle, createGridStyle |
| `prototype` | Prototypes and overlays; 原型; 热区; 浮层; 点击跳转; prototype; overlay | reactions, setReactionsAsync, Reaction, Transition, ReactionMixin, FramePrototypingMixin |
| `motion` | Keyframes and easing; 关键帧; 缓动; 动画曲线; 先后进场; 依次出现; keyframe; easing | motion, timelines, manualKeyframeTracks, applyManualKeyframeTrack, Easing |
| `motion` | Custom animation styles; 自定义动画样式; 动画预设; animation style | createCustomAnimationStyle, getLocalCustomAnimationStylesAsync, applyAnimationStyle |
| `motion` | Text stagger; 文字逐字动画; 错峰动画; text stagger | figmaAnimationStyles, AvailableAnimationStyle, AppliedAnimationStyle, animationStyles |
| `figjam` | Shapes and sticky notes; 便利贴; 白板形状; sticky; shape with text | createSticky, createShapeWithText, createSection |
| `figjam` | Connected diagrams; 流程图; 连接线; 箭头; flowchart; connector | createConnector, connectorStart, connectorEnd |
| `figjam` | Tables and code blocks; 表格; 代码块; code block; table | createTable, createCodeBlock, TableNode |
| `slides` | Slides and rows; 幻灯片; 演示文稿; slide grid; slide row | createSlide, createSlideRow, getSlideGrid, setSlideGrid |
| `handoff` | CSS and code handoff; CSS; 代码交付; 设计转代码; design to code | getCSSAsync, figma_design_context, figma_download_assets |
| `handoff` | Dev Resources and Code Connect; 代码映射; 开发资源; SwiftUI; Code Connect; dev resources | addDevResourceAsync, getDevResourcesAsync, figma_components |
| `execution` | Native exports; 导出; PNG; SVG; PDF; MP4; WEBM; JSON_REST_V1; export | figma_export_node, exportAsync, ExportSettingsREST |
| `execution` | Original receipt and recovery; 原始回执; 断线恢复; 不确定结果; receipt; reconcile | figma_job, figma_reconcile, figma_export |
| `shaders` | Shader effects; 着色器; shader | listAvailableShaders, importShaderById, ShaderPaint, propertyMetadata |
| `community` | Community references; 社区模板; 社区参考; UI kit; community | figma_community |
| `cloud` | Separate cloud services; 云端建文件; Make; Specs; Code Layers; hosted service | figma_api |
| `execution` | Conditional edits; 并发; 多任务; 条件写入; 工作区; 冲突; concurrency; conflict | figma_snapshot, figma_run |

## Local and hosted execution

Native `figma.util.rgb`, `rgba` and `solidPaint` are public utilities. The hosted SF Symbol lookup helper is a different capability. Hosted `node.query`, `node.set`, `node.screenshot` and `figma.createAutoLayout` map locally to native searches, `bridge.set`, `bridge.screenshot` and `bridge.autoLayout`. Native pages are not reset between calls; operations serialize per file.

The manifest enables Design, FigJam and Slides, not Dev Mode or Buzz entrypoints. Declarations may include editor-specific or restricted APIs. Cloud-file creation, Make, Specs, hosted compilers and publication need their own services; see [boundaries](capabilities.md).

Prefer native editable structure to external approximations. Resolve the exact file and affected nodes, discover the operation, execute a coherent edit, then read back/export its actual result. Use GUI only for a concrete uncovered lifecycle step or requested interactive test.
