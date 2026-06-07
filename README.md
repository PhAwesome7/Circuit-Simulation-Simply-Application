# Circuit-Simulation-Simply-Application
基于智能体编写的能够构建简易电路并得正确数据的仿真微信小程序：

---

# 电路模拟器微信小程序 - 开发文档

## 1. 项目概述
电路模拟器是一款基于微信小程序的交互式电路仿真工具。用户可以在画布上自由摆放电阻、电池、开关、灯泡、电机等电子元件，通过导线连接形成电路，并实时查看电路状态（开路/闭合/短路）以及每个元件的电压、电流、功率等参数。该工具适用于电子技术教学、电路实验演示及爱好者学习。

**主要特性：**
- 可视化元件库，支持拖拽添加元件
- 元件可旋转、移动、删除
- 端子点对点连接，自动生成导线
- 实时电路分析（基于改进节点电压法）
- 参数调节（电阻值、电池电压/内阻、灯泡/电机电阻等）
- 开关控制电路通断
- 撤销/重做功能
- 网格吸附，精准布局

## 2. 技术栈

| 类别 | 技术/框架 |
|------|-----------|
| 小程序框架 | 微信小程序（Skyline 渲染引擎 + glass-easel 组件框架） |
| 语言 | TypeScript |
| 样式预处理器 | Less |
| 页面构成 | 单页面模式（pages/index/index） |
| 开发工具 | 微信开发者工具 |

小程序配置（app.json）启用了 Skyline 渲染、自定义导航栏、按需注入等优化特性。

## 3. 文件结构

```
project/
├── app.json               # 应用配置（页面路由、窗口样式、渲染器选项）
├── app.less               # 全局样式（仅包含示例容器，实际样式以页面级为主）
├── app.ts                 # 应用入口，登录及日志记录
├── pages/
│   └── index/
│       ├── index.json     # 页面配置（导航栏标题、背景色等）
│       ├── index.less     # 页面样式（含元器件、导线、面板等全部视觉样式）
│       ├── index.ts       # 页面逻辑（电路模型、交互事件、求解算法）
│       └── index.wxml     # 页面模板（UI结构）
├── sitemap.json           # 站点地图配置
└── ...其他资源
```

## 4. 功能模块与交互设计

### 4.1 整体布局
页面采用上下 + 左右复合布局（自 index.less 中的样式定义）：

- **顶部栏（.top-bar）**：显示标题"电路模拟器"、当前电路状态（开路/闭合/短路）及提示信息。
- **主工作区（.main-workspace）**：左右两列
  - 左侧（.workspace-container）：画布区域，包含元件操作栏（旋转、删除等）和绘图区（.workspace），背景为网格
  - 右侧（.info-panel）：信息面板，展示电路总体参数（总电压、总电流、总电阻、总功率），以及选中元件的详细参数和调节控件
- **底部元器件库（.component-library）**：横向滚动网格，列出5种元件（电阻、电池、开关、灯泡、电机），点击即可添加至画布

### 4.2 元件模型
所有元件继承自 ComponentData 接口（见 index.ts）：

```typescript
interface ComponentData {
  id: string;                // 唯一标识
  type: string;              // 'resistor' | 'battery' | 'switch' | 'bulb' | 'motor'
  label: string;             // 显示名称（如"电阻1"）
  x: number;                 // 画布坐标（左上角）
  y: number;                 // 画布坐标（左上角）
  rotate: number;            // 旋转角度（0/90/180/270）
  zIndex: number;            // 层级（拖动时提高）
  selected: boolean;         // 是否被选中
  status: string;            // 'on' | 'off' | 'running'
  state: string;             // 仅开关使用：'open' | 'closed'
  connectedTerminals: Record<number, boolean>; // 两个端子的连接状态
  voltage: number;           // 实时电参数
  current: number;           // 实时电参数
  power: number;             // 实时电参数
  // 各类型特有参数：
  resistance?: number;       // 电阻值（Ω）
  voltageValue?: number;     // 电池电压（V）
  internalResistance?: number; // 电池内阻（Ω）
  bulbResistance?: number;   // 灯泡电阻（Ω）
  motorResistance?: number;  // 电机电阻（Ω）
  ratedPower?: number;       // 额定功率（W）
}
```

### 4.3 导线模型
导线数据 WireData 存储连接信息及绘制参数：

```typescript
interface WireData {
  id: string;
  start: { x: number; y: number }; // 实际屏幕坐标（实时更新）
  end: { x: number; y: number };   // 实际屏幕坐标（实时更新）
  length: number;                  // 用于CSS变换
  angle: number;                   // 用于CSS变换
  startComponent: string;          // 元件ID
  endComponent: string;            // 元件ID
  startTerminal: number;           // 端子编号（1或2）
  endTerminal: number;             // 端子编号（1或2）
  current: number;                 // 流经导线的电流（分析结果）
}
```

### 4.4 交互流程

#### 添加元件
点击底部库中的元件图标 → 调用 `addComponent`，生成随机初始位置（可吸附到网格），增加计数，自动保存状态。

#### 移动元件
触摸元件开始拖动（`onComponentTouchStart`）→ 移动时更新位置 → 结束拖动后更新所有导线端点（`updateWirePositions`），重新分析电路。

#### 连接导线
点击元件的某个端子（.terminal）→ 进入连接模式，记录起点。
点击另一个元件的端子 → 创建导线，检查重复连接，更新两个元件的 `connectedTerminals` 标志。
连接过程中点击空白区域可取消。

#### 删除导线
点击导线（`onWireTap`）→ 弹窗确认 → 删除导线并重置相关端子的连接标志。

#### 选中元件与参数调节
单击元件 → 右侧面板显示该元件的详细参数（电阻值、电池电压等），支持滑动条或预设按钮修改。开关元件可切换开闭状态。

#### 旋转与删除选中元件
通过左侧工作区顶部的按钮执行。

#### 撤销/重做
基于历史栈（最多20步），每次元件增删、移动、参数修改后自动保存状态。

### 4.5 页面模板结构（index.wxml）
页面模板采用原生微信小程序语法，通过数据绑定和事件绑定实现完整交互。以下为核心结构说明：

#### 顶部状态栏
```xml
<view class="top-bar">
  <view class="title">电路模拟器</view>
  <view class="circuit-status {{circuitStatus}}">{{circuitStatusText}}</view>
</view>
```
- `circuitStatus` 动态类（open/closed/short/complex）控制背景色和文字颜色
- `circuitStatusText` 显示"电路开路""电路闭合""短路"等提示

#### 左侧画布工作区
工作区头部：包含"工作区"标题、连接提示（连接模式下显示当前选中的端子）、开始模拟和清空工作区按钮。

画布区域（class="workspace"）：
- 网格背景（.grid-background）
- 元件列表渲染：`<block wx:for="{{components}}">`，每个元件包含：
  - 绝对定位的容器，样式绑定 left、top、`transform: rotate({{item.rotate}}deg)`
  - 拖拽事件：`bindtouchstart`、`bindtouchmove`、`bindtouchend`
  - 元件的图标和两个端子（.terminal），端子绑定 `bindtap="onTerminalTap"` 并传递 `data-id` 和 `data-terminal`。通过 `getTerminalClass` 方法返回 'connected' 或 'selected-terminal' 样式类
- 导线列表渲染：`<block wx:for="{{wires}}">`，每个导线：
  - 样式：`left: {{item.start.x}}px; top: {{item.start.y}}px; width: {{item.length}}px; transform: rotate({{item.angle}}rad);`
  - 绑定 `bindtap="onWireTap"` 以支持删除
  - 导线中央显示电流数值（`{{item.currentDisplay}}A`）

#### 右侧信息面板
面板头部：标题"电路信息"，可折叠按钮。

未选中元件时：
- 显示电路概览（总电压、总电流、总电阻、总功率），数值来自 `circuitSummary.totalVoltageDisplay` 等
- 显示元器件列表（`<scroll-view class="component-list">`），每个元件项显示其电压、电流、功率，点击可选中该元件

选中元件时：
- 显示元件详情（标识、电压、电流、功率，功率过载时高亮）
- 根据元件类型动态显示参数调节滑块和预设按钮（电阻值、电池电压/内阻、灯泡/电机电阻及额定功率）
- 开关显示切换按钮
- 底部提供"旋转元器件"和"删除元器件"按钮

#### 底部元器件库
横向网格布局（.library-grid），5个元件项（电阻、电池、开关、灯泡、电机）。
- 每个项绑定 `bindtap="addComponent"` 添加元件，`bindlongpress="showComponentInfo"` 长按查看说明
- 元件图标通过 CSS 绘制（.resistor-icon、.battery-icon 等），无需外部图片

### 4.6 状态与样式联动
- 电路状态样式：`.circuit-status.open`、`.circuit-status.closed`、`.circuit-status.short`、`.circuit-status.complex` 分别对应不同背景色和边框
- 端子连接样式：`.terminal.connected`（绿色）、`.terminal.selected`（橙色）
- 元件工作动画：
  - 灯泡：`.filament.glow` 添加发光效果和闪烁动画
  - 电机：`.motor-shape.running` 下的 `.motor-shaft` 执行旋转动画
  - 导线：`.wire.connected` 添加流动背景动画（currentFlow）

## 5. 核心算法实现

### 5.1 电路求解器（CircuitSolver 类）
采用改进节点电压法（Modified Nodal Analysis），支持含内阻的电池、开关（开路视为无穷大电阻，闭合视为小电阻）、电阻性负载（灯泡、电机、电阻元件）。

**主要步骤：**
1. 建立并查集合并端子：根据导线连接关系将各元件的两个端子合并为若干电气节点（reprs 映射）
2. 构建导纳矩阵 G 和注入电流向量 I
   - 电池：转换为诺顿等效电路（电流源 $I_n=E/r$ 并联电导 $g=1/r$），将电流源注入两个节点，电导加入矩阵
   - 电阻、闭合开关、灯泡、电机：直接添加电导 $g=1/R$
   - 开路开关：忽略（不添加任何导纳/电流）
3. 指定参考节点（取最后一个节点为地），去掉参考节点的行列，形成缩减矩阵 A 和向量 B
4. 高斯消元求解节点电压（含列主元交换，处理奇异矩阵）
5. 回代计算各元件电流、电压、功率：
   - 电池：$I_{ext}=I_n-(V_a-V_b)/r$，$V_{term}=V_a-V_b$
   - 电阻类：$I=(V_a-V_b)/R$，$P=V_{ab}·I$
   - 开路开关：电流/功率为0
6. 汇总总参数：总电压 = 所有电池电动势之和，总电流 = 各元件电流绝对值的最大值（实际取最大分量电流），总功率 = 各元件功率绝对值之和，总电阻 = 总电压 / 总电流（当总电流 > 0）

> 注：代码中还保留了一个 CircuitAnalyzer 类（基于简单回路法），但实际页面调用的是 CircuitSolver.analyze，后者更为通用。

### 5.2 性能优化
- 拖动时使用 setTimeout 延迟更新导线坐标（`_updateTimer`），避免频繁重绘
- 网格吸附算法：坐标四舍五入到 gridSize（20px）的整数倍
- 历史记录仅深拷贝 components 和 wires，避免冗余数据

## 6. 页面样式关键点
（参考 index.less）

- **画布网格**：使用 linear-gradient 绘制 20×20 的点阵背景，透明度 0.3
- **元件卡片**：
  - 绝对定位，带阴影和圆角
  - 各类型元件宽度/高度略有差异（如电池 40×50，电阻 60×30）
  - 边框颜色区分类型（电阻棕色，电池红色等）
  - 内部图标通过伪元素和 flex 布局绘制（非图片）
- **端子（.terminal）**：
  - 8px 圆形，灰底白边
  - 连接成功变为绿色（.terminal.connected）
  - 待连接起点高亮为橙色（.terminal.selected）
- **导线（.wire）**：
  - 绝对定位，高度 2px，通过 transform: rotate 实现方向
  - 有电流时变为红色并添加流动动画（currentFlow）
- **响应式**：移动端（宽度≤768px）将右侧面板移到下方，库网格保持5列

## 7. 数据流与状态管理
页面数据全部存储在 Page.data 中，主要字段：

```typescript
data: {
  components: ComponentData[];   // 所有元件
  wires: WireData[];             // 所有导线
  circuitStatus: 'open' | 'closed' | 'short' | 'complex';
  circuitSummary: CircuitSummary; // 总体参数
  selectedComponent: ComponentData | null;
  connectingMode: boolean;       // 是否正在连接端子
  selectedTerminal: { componentId: string; terminal: number } | null;
  history: any[];                // 状态快照
  historyIndex: number;
  gridSnap: boolean;
  // ... 其他UI标志
}
```

每次用户操作（添加、移动、连接、删除、参数修改）都会调用 `saveState()` 将当前 components 和 wires 深拷贝推入历史栈。

**电路重新分析触发时机：**
- 导线增删后
- 元件移动结束后
- 开关状态改变后
- 元件参数（电阻、电压等）改变后
- 清空画布后

## 8. 使用说明

### 8.1 快速开始
1. 启动小程序，进入"电路模拟器"主界面
2. 从底部元件库点击任意元件（如"电池"），元件会出现在画布中央附近
3. 重复添加其他元件（电阻、开关、灯泡等）
4. 点击元件端子（小圆点）进入连接模式，再点击另一元件的端子，即可生成导线
5. 连接所有元件形成一个闭合回路（需包含电池和至少一个负载）
6. 系统自动分析电路，顶部状态栏显示"电路闭合"，右侧面板显示总电压/电流/电阻/功率，各元件内部也会显示实时电压/电流

### 8.2 元件操作
- **移动**：长按并拖动元件
- **旋转**：先单击选中元件，再点击工作区顶部的旋转按钮（↻）
- **删除**：选中元件后点击删除按钮（🗑）或直接点击导线选择删除
- **调节参数**：选中元件后，右侧面板会出现对应的滑动条和预设值（如电阻100Ω、1kΩ等）。电池支持调节电压和内阻；开关支持点击"切换状态"按钮
- **撤销/重做**：通过顶部栏按钮（↶/↷）执行

### 8.3 注意事项
- 连接时不能将同一元件的两个端子互连（会提示无效）
- 重复连接同一对端子会被阻止
- 若电路存在开路（开关断开或缺少导线），总电流为0，元件不工作
- 短路检测：当总电流异常大（>1e8）时，状态显示"短路"，元件功率可能极大（需注意实际安全，软件中仅数值提示）
- 网格吸附默认开启，有助于整齐排列元件

## 9. 扩展与维护建议

### 9.1 添加新元件类型
1. 在 ComponentData 接口中增加必要的字段（如电容的容值）
2. 在 CircuitSolver.analyze 的元件处理分支中添加对应的导纳/电流源模型（例如电容需动态特性，当前仅支持直流稳态，可先作为开路处理）
3. 在 addComponent 中初始化新元件的默认参数
4. 在 index.less 中定义新元件的尺寸、边框颜色和内部图标样式
5. 在底部库的 library-grid 中添加对应的图标和点击事件，并在 index.wxml 中增加相应的模板分支

### 9.2 增强求解器
- 目前仅支持直流稳态分析。若要支持交流或暂态，需引入复数运算和微分方程求解
- 可扩展为支持电容、电感、二极管等非线性元件（需迭代求解）

### 9.3 性能优化
- 当画布元件数量超过30个时，导线实时重绘可能造成卡顿，可考虑使用 canvas 替代绝对定位的 DOM 元素绘制导线
- 历史记录可压缩存储（如仅记录差异），减少内存占用

## 10. 已知限制
- 电路求解器对于复杂网络（非简单串并联）虽采用节点电压法，但若存在多个电压源且无公共参考点可能导致奇异矩阵，代码已做回退处理（返回零电流）
- 导线电流显示使用了起点元件的电流值，在多条支路并联时不够精确，但不影响整体教学演示
- 不支持元件文本标注的自定义编辑

## 11. 总结
本电路模拟器微信小程序提供了一个直观、易用的电路仿真环境，利用改进节点电压法实现实时分析，适合电子技术初学者进行实验和验证。代码结构清晰，扩展性强，可作为教学工具或进一步开发更复杂电路仿真应用的基础。

---

**文档版本：** 2.0  
**最后更新：** 2026-06-07  
**对应完整代码文件：** index.json, index.less, index.ts, index.wxml, app.json

---
