// index.rewrite.ts

// 类型定义
interface ComponentData {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  rotate: number;
  zIndex: number;
  selected: boolean;
  status: string;
  state: string; // for switch
  connectedTerminals: Record<number, boolean>;
  voltage: number;
  current: number;
  power: number;
  resistance?: number;
  ratedPower?: number;
  voltageValue?: number;
  internalResistance?: number;
  bulbResistance?: number;
  motorResistance?: number;
}

interface WireData {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  length: number;
  angle: number;
  startComponent: string;
  startTerminal: number;
  endComponent: string;
  endTerminal: number;
  current: number;
}

interface CircuitSummary {
  totalVoltage: number;
  totalCurrent: number;
  totalResistance: number;
  totalPower: number;
}

interface SelectedTerminal { componentId: string; terminal: number }
interface DragOffset { x: number; y: number }

class CircuitAnalyzer {
  static getComponentResistance(c: ComponentData): number {
    switch (c.type) {
      case 'resistor': return c.resistance ?? 0;
      case 'battery': return c.internalResistance ?? 0;
      case 'switch': return c.state === 'closed' ? 0.001 : 1e9;
      case 'bulb': return c.bulbResistance ?? 0;
      case 'motor': return c.motorResistance ?? 0;
      default: return 0;
    }
  }

  // 返回更详细的分析结果：summary + per-component 计算 + 每条导线电流
  static analyze(components: ComponentData[], wires: WireData[]) {
    // 建立并查集，把所有端子分为节点
    const parent: Record<string, string> = {};
    function find(a: string) {
      if (!parent[a]) parent[a] = a;
      if (parent[a] !== a) parent[a] = find(parent[a]);
      return parent[a];
    }
    function union(a: string, b: string) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    components.forEach(c => { parent[`${c.id}_1`] = `${c.id}_1`; parent[`${c.id}_2`] = `${c.id}_2`; });
    wires.forEach(w => union(`${w.startComponent}_${w.startTerminal}`, `${w.endComponent}_${w.endTerminal}`));

    // 映射代表元（连通节点）到索引
    const reprs = new Map<string, number>();
    let nid = 0;
    Object.keys(parent).forEach(k => { const r = find(k); if (!reprs.has(r)) reprs.set(r, nid++); });

    // 终端到节点索引
    const termNode: Record<string, number> = {};
    components.forEach(c => { termNode[`${c.id}_1`] = reprs.get(find(`${c.id}_1`)) ?? -1; termNode[`${c.id}_2`] = reprs.get(find(`${c.id}_2`)) ?? -1; });

    // 边：每个元件作为一条边连接两个节点
    const edges = components.map(c => ({
      id: c.id,
      comp: c,
      a: termNode[`${c.id}_1`],
      b: termNode[`${c.id}_2`],
      resistance: this.getComponentResistance(c),
      emf: c.type === 'battery' ? (c.voltageValue ?? 0) : 0,
      internalR: c.type === 'battery' ? (c.internalResistance ?? 0) : 0,
      isBattery: c.type === 'battery',
      isOpenSwitch: c.type === 'switch' && c.state === 'open'
    }));

    // 构建节点邻接表（基于边）
    const adj: Record<number, Array<{node:number, edgeIdx:number}>> = {};
    for (let i = 0; i < nid; i++) adj[i] = [];
    edges.forEach((e, idx) => {
      if (e.a >= 0) adj[e.a].push({ node: e.b, edgeIdx: idx });
      if (e.b >= 0) adj[e.b].push({ node: e.a, edgeIdx: idx });
    });

    // 按连通分量处理（以节点为单位）
    const seenNode = new Set<number>();
    const componentResults: Record<string, { voltage: number; current: number; power: number; status: string }> = {};
    const wireCurrents: Record<string, number> = {};
    const summaries: Array<{ totalVoltage:number, totalCurrent:number, totalResistance:number, totalPower:number, nodes:number[], edgesIdx:number[] }> = [];

    for (let start = 0; start < nid; start++) {
      if (seenNode.has(start)) continue;
      // BFS 收集分量节点
      const q = [start]; seenNode.add(start);
      const nodes = [start];
      while (q.length) {
        const u = q.shift()!;
        for (const nb of adj[u]) {
          if (!seenNode.has(nb.node)) { seenNode.add(nb.node); q.push(nb.node); nodes.push(nb.node); }
        }
      }
      // 收集属于此分量的边
      const edgesIdx: number[] = [];
      edges.forEach((e, idx) => { if (nodes.includes(e.a) || nodes.includes(e.b)) edgesIdx.push(idx); });
      if (edgesIdx.length === 0) continue;

      // 判断是否包含电池
      const hasBattery = edgesIdx.some(i => edges[i].isBattery);
      // 判断是否存在开路开关
      const hasOpenSwitch = edgesIdx.some(i => edges[i].isOpenSwitch);

      // 简单回路检测：所有节点度数为2且连通且边数等于节点数
      const nodeDegrees = nodes.map(n => adj[n].length);
      const isSimpleLoop = nodeDegrees.every(d => d === 2) && edgesIdx.length === nodes.length && hasBattery;

      let totalV = 0, totalR = 0, current = 0, totalP = 0;
      if (!hasBattery) {
        // 没有电源，所有电流为0
        current = 0;
      } else if (hasOpenSwitch) {
        current = 0;
      } else if (isSimpleLoop) {
        // 按顺序遍历回路，计算总电动势和总电阻
        const loopNodes: number[] = [];
        // 构造有序节点序列
        let u0 = nodes[0];
        loopNodes.push(u0);
        let prev = -1, cur = u0;
        while (true) {
          const nextEntry = adj[cur].find(x => x.node !== prev);
          if (!nextEntry) break;
          const nxt = nextEntry.node;
          if (nxt === u0) break; // 回到起点
          loopNodes.push(nxt);
          prev = cur; cur = nxt;
          if (loopNodes.length > 1000) break; // 避免死循环
        }
        // 计算沿顺序的边
        const L = loopNodes.length;
        let emfSum = 0;
        for (let i = 0; i < L; i++) {
          const a = loopNodes[i];
          const b = loopNodes[(i+1)%L];
          // 找到连接 a-b 的边
          const edgeIdx = adj[a].find(x => x.node === b)?.edgeIdx;
          if (edgeIdx === undefined) continue;
          const e = edges[edgeIdx];
          const r = (e.isBattery ? (e.internalR ?? 0) : e.resistance) ?? 0;
          totalR += r;
          // 电池的极性：定义组件的 a 对应 terminal1, b 对应 terminal2
          // 在 edges 中 a=terminal1 node, b=terminal2 node
          if (e.isBattery) {
            // 如果在遍历方向从 terminal2 -> terminal1（即 b->a），则电动势增加
            if (e.b === a && e.a === b) {
              emfSum += e.emf;
            } else if (e.a === a && e.b === b) {
              emfSum -= e.emf;
            } else {
              // 如果连线方向不清晰，按正向加
              emfSum += e.emf;
            }
          }
          if (!e.isBattery) {
            // 其他元件阻值也计入总内阻
            // already added via r
          }
        }
        emfSum = this.round(emfSum);
        totalV = emfSum;
        if (totalR <= 1e-12) {
          current = Number.MAX_SAFE_INTEGER / 1e6;
        } else {
          current = emfSum / totalR;
        }
        current = this.round(current);
        totalP = this.round(totalV * current);
      } else {
        // 非简单回路：退化为近似处理（把所有电阻并联/串联复杂求解超出当前scope）
        // 采用简化：总电压为所有电池电压之和，总电阻近似为所有边阻值之和
        totalV = edgesIdx.reduce((s,i)=> s + (edges[i].isBattery ? edges[i].emf : 0), 0);
        totalR = edgesIdx.reduce((s,i)=> s + (edges[i].isBattery ? (edges[i].internalR ?? 0) : edges[i].resistance), 0);
        if (hasOpenSwitch) current = 0; else if (totalR <= 1e-12) current = Number.MAX_SAFE_INTEGER / 1e6; else current = totalV / totalR;
        current = this.round(current);
        totalP = this.round(totalV * current);
      }

      // 记录每个边的电压/电流/功率
      edgesIdx.forEach(i => {
        const e = edges[i];
        const r = (e.isBattery ? (e.internalR ?? 0) : e.resistance) ?? 0;
        let v = 0; let p = 0; let status = 'off';
        if (current === 0) { v = 0; p = 0; status = 'off'; }
        else {
          if (e.isBattery) {
            // 端子电压 = emf - I * internalR
            v = this.round((e.emf ?? 0) - current * (e.internalR ?? 0));
            p = this.round(v * current);
            status = 'on';
          } else {
            v = this.round(current * (e.resistance ?? 0));
            p = this.round(v * current);
            status = (current > 1e-6) ? (e.comp.type === 'bulb' ? 'on' : (e.comp.type === 'motor' ? 'running' : 'on')) : 'off';
          }
        }
        componentResults[e.id] = { voltage: v, current: this.round(current), power: p, status };
      });

      // 给分量内的导线赋予电流值
      wires.forEach(w => {
        // 如果该导线两端的终端位于当前分量的节点集合，则认为该导线承载该分量电流
        const n1 = reprs.get(find(`${w.startComponent}_${w.startTerminal}`));
        const n2 = reprs.get(find(`${w.endComponent}_${w.endTerminal}`));
        if (n1 !== undefined && n2 !== undefined) {
          const node1 = reprs.has(n1 as any) ? n1 as any : n1;
        }
      });

      // 为简化，把分量中所有导线标为相同电流
      edgesIdx.forEach(i => {});
      wires.forEach(w => {
        const t1 = find(`${w.startComponent}_${w.startTerminal}`);
        const t2 = find(`${w.endComponent}_${w.endTerminal}`);
        // 如果任一端属于本分量的节点集合
        const nodeIdx1 = reprs.get(find(t1));
        const nodeIdx2 = reprs.get(find(t2));
        if (nodeIdx1 !== undefined || nodeIdx2 !== undefined) {
          wireCurrents[w.id] = this.round(current);
        }
      });

      summaries.push({ totalVoltage: totalV, totalCurrent: current, totalResistance: totalR, totalPower: totalP, nodes, edgesIdx });
    }

    // 汇总 summary：选取电流最大的分量作为“主要电路”展示
    let mainSummary = { totalVoltage: 0, totalCurrent: 0, totalResistance: 0, totalPower: 0 };
    if (summaries.length > 0) {
      summaries.sort((a,b) => Math.abs(b.totalCurrent) - Math.abs(a.totalCurrent));
      const s = summaries[0];
      mainSummary = { totalVoltage: this.round(s.totalVoltage), totalCurrent: this.round(s.totalCurrent), totalResistance: this.round(s.totalResistance), totalPower: this.round(s.totalPower) };
    }

    return { summary: mainSummary, componentResults, wireCurrents };
  }

  static round(v: number, d = 6) { const m = Math.pow(10, d); return Math.round(v * m) / m }
}

class CircuitSolver {
  static round(v: number, d = 6) { const m = Math.pow(10, d); return Math.round(v * m) / m }

  // 使用节点电压法（Nodal analysis），将含电池（带内阻）转换为诺顿等效：电流源并联电阻
  // 返回 { summary, componentResults, wireCurrents }
  static analyze(components: ComponentData[], wires: WireData[]) {
    // 并查集把端子合并为节点
    const parent: Record<string, string> = {};
    function find(a: string) { if (!parent[a]) parent[a] = a; if (parent[a] !== a) parent[a] = find(parent[a]); return parent[a]; }
    function union(a: string, b: string) { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }

    components.forEach(c => { parent[`${c.id}_1`] = `${c.id}_1`; parent[`${c.id}_2`] = `${c.id}_2`; });
    wires.forEach(w => union(`${w.startComponent}_${w.startTerminal}`, `${w.endComponent}_${w.endTerminal}`));

    // 收集代表元，并为每个代表元分配索引
    const reprs = new Map<string, number>();
    let nid = 0;
    Object.keys(parent).forEach(k => { const r = find(k); if (!reprs.has(r)) reprs.set(r, nid++); });
    if (nid === 0) return { summary: { totalVoltage: 0, totalCurrent: 0, totalResistance: 0, totalPower: 0 }, componentResults: {}, wireCurrents: {} };

    // 终端到节点索引
    const termNode: Record<string, number> = {};
    components.forEach(c => { termNode[`${c.id}_1`] = reprs.get(find(`${c.id}_1`)) ?? -1; termNode[`${c.id}_2`] = reprs.get(find(`${c.id}_2`)) ?? -1; });

    // 构建导纳矩阵 G 和注入电流向量 I (所有节点包含)
    const G: number[][] = Array.from({ length: nid }, () => Array(nid).fill(0));
    const I: number[] = Array(nid).fill(0);

    // 辅助：加入导纳
    function addConductance(a: number, b: number, g: number) {
      if (a < 0 || b < 0) return;
      if (a === b) { G[a][a] += g; return; }
      G[a][a] += g; G[b][b] += g; G[a][b] -= g; G[b][a] -= g;
    }
    function addCurrent(node: number, value: number) { if (node < 0) return; I[node] += value; }

    // 记录组件属性以便计算电流
    const compInfo: Record<string, any> = {};
    components.forEach(c => {
      const a = termNode[`${c.id}_1`];
      const b = termNode[`${c.id}_2`];
      if (a === undefined || b === undefined) return;
      if (c.type === 'switch' && c.state === 'open') {
        // 开路，忽略
        compInfo[c.id] = { a, b, type: 'open' };
        return;
      }
      if (c.type === 'battery') {
        const emf = c.voltageValue ?? 0;
        let r = c.internalResistance ?? 0.0;
        if (r <= 1e-12) r = 1e-6; // 避免理想电压源
        const g = 1 / r;
        // 将带内阻电池替换为诺顿等效：并联电阻 + 电流源（从端子1->端子2，方向约定端子1为正）
        addConductance(a, b, g);
        const In = emf / r; // 从端子1 流向端子2
        addCurrent(a, In);
        addCurrent(b, -In);
        compInfo[c.id] = { a, b, type: 'battery', emf, r };
        return;
      }

      // 其他元件当作电阻处理（电阻、电阻型灯泡、电机、闭合开关）
      const R = Math.max(CircuitAnalyzer.getComponentResistance(c), 1e-12);
      const g = 1 / R;
      addConductance(a, b, g);
      compInfo[c.id] = { a, b, type: 'resistor-like', R };
    });

    // 选取参考节点（取最后一个节点作为地）
    const ref = nid - 1;
    const m = nid - 1; // 未知节点数

    // 如果没有未知节点（只有一个节点），电压均为0
    if (m <= 0) {
      // 节点电压为0
      const V = Array(nid).fill(0);
      // 计算组件电流
      const componentResults: Record<string, any> = {};
      Object.keys(compInfo).forEach(id => {
        const info = compInfo[id];
        if (info.type === 'open') componentResults[id] = { voltage: 0, current: 0, power: 0, status: 'off' };
        else if (info.type === 'battery') {
          const Va = V[info.a], Vb = V[info.b];
          const In = info.emf / info.r; const Iext = In - (Va - Vb) / info.r; const vterm = Va - Vb; componentResults[id] = { voltage: CircuitSolver.round(vterm), current: CircuitSolver.round(Iext), power: CircuitSolver.round(vterm * Iext), status: Math.abs(Iext) > 1e-6 ? 'on' : 'off' };
        } else {
          const Va = V[info.a], Vb = V[info.b]; const I = (Va - Vb) / info.R; componentResults[id] = { voltage: CircuitSolver.round(Va - Vb), current: CircuitSolver.round(I), power: CircuitSolver.round((Va - Vb) * I), status: Math.abs(I) > 1e-6 ? 'on' : 'off' };
        }
      });
      const wireCurrents: Record<string, number> = {};
      wires.forEach(w => { const comp = this._findComponentById(components, w.startComponent); wireCurrents[w.id] = componentResults[comp?.id ?? '']?.current ?? 0; });
      const totalPower = Object.values(componentResults).reduce((s: any, r: any) => s + Math.abs(r.power || 0), 0);
      const batterySum = components.filter(c=>c.type==='battery').reduce((s,c)=>(s + (c.voltageValue ?? 0)),0);
      return { summary: { totalVoltage: CircuitSolver.round(batterySum), totalCurrent: 0, totalResistance: 0, totalPower: CircuitSolver.round(totalPower) }, componentResults, wireCurrents };
    }

    // 构建简化矩阵：去掉参考节点的行列
    const A: number[][] = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => G[i < ref ? i : i + 1][j < ref ? j : j + 1]));
    const B: number[] = Array.from({ length: m }, (_, i) => I[i < ref ? i : i + 1]);

    // 高斯消元（带列交换）求解 A * x = B
    function solveLinear(mat: number[][], vec: number[]) {
      const n = mat.length;
      // 深拷贝
      const A2 = mat.map(r => r.slice());
      const b2 = vec.slice();
      for (let k = 0; k < n; k++) {
        // 寻找主元
        let maxRow = k; let maxVal = Math.abs(A2[k][k]);
        for (let i = k + 1; i < n; i++) { const av = Math.abs(A2[i][k]); if (av > maxVal) { maxVal = av; maxRow = i; } }
        if (maxVal < 1e-12) return null; // 奇异
        if (maxRow !== k) { const tmp = A2[k]; A2[k] = A2[maxRow]; A2[maxRow] = tmp; const tv = b2[k]; b2[k] = b2[maxRow]; b2[maxRow] = tv; }
        // 消元
        for (let i = k + 1; i < n; i++) {
          const factor = A2[i][k] / A2[k][k];
          if (!isFinite(factor)) continue;
          for (let j = k; j < n; j++) A2[i][j] -= factor * A2[k][j];
          b2[i] -= factor * b2[k];
        }
      }
      // 回代
      const x = Array(n).fill(0);
      for (let i = n - 1; i >= 0; i--) {
        let s = b2[i];
        for (let j = i + 1; j < n; j++) s -= A2[i][j] * x[j];
        x[i] = s / A2[i][i];
      }
      return x;
    }

    const sol = solveLinear(A, B);
    if (!sol) {
      // 奇异矩阵，返回零电流（回退）
      const componentResults: Record<string, any> = {};
      Object.keys(compInfo).forEach(id => { componentResults[id] = { voltage: 0, current: 0, power: 0, status: 'off' }; });
      const wireCurrents: Record<string, number> = {};
      wires.forEach(w => wireCurrents[w.id] = 0);
      return { summary: { totalVoltage: 0, totalCurrent: 0, totalResistance: 0, totalPower: 0 }, componentResults, wireCurrents };
    }

    // 重建完整节点电压
    const Vfull = Array(nid).fill(0);
    for (let i = 0; i < m; i++) { const idx = i < ref ? i : i + 1; Vfull[idx] = sol[i]; }
    Vfull[ref] = 0;

    // 计算组件电流与功率
    const componentResults: Record<string, any> = {};
    Object.keys(compInfo).forEach(id => {
      const info = compInfo[id];
      if (info.type === 'open') { componentResults[id] = { voltage: 0, current: 0, power: 0, status: 'off' }; return; }
      const Va = Vfull[info.a] ?? 0; const Vb = Vfull[info.b] ?? 0;
      if (info.type === 'battery') {
        const In = info.emf / info.r; // 从端子1->端子2
        const Iext = In - (Va - Vb) / info.r; // 从端子1->端子2
        const vterm = Va - Vb;
        componentResults[id] = { voltage: CircuitSolver.round(vterm), current: CircuitSolver.round(Iext), power: CircuitSolver.round(vterm * Iext), status: Math.abs(Iext) > 1e-6 ? 'on' : 'off' };
      } else {
        const Icomp = (Va - Vb) / info.R; const vterm = Va - Vb; componentResults[id] = { voltage: CircuitSolver.round(vterm), current: CircuitSolver.round(Icomp), power: CircuitSolver.round(vterm * Icomp), status: Math.abs(Icomp) > 1e-6 ? 'on' : 'off' };
      }
    });

    // 计算导线电流，采用起点元件的电流作为导线电流
    const wireCurrents: Record<string, number> = {};
    wires.forEach(w => {
      const comp = components.find(c => c.id === w.startComponent);
      const cur = comp ? (componentResults[comp.id]?.current ?? 0) : 0;
      wireCurrents[w.id] = CircuitSolver.round(cur);
    });

    // 汇总 summary：总电压取所有电池电动势之和，总电流取最大绝对分量电流，总功率为各元件功率和
    const batterySum = components.filter(c => c.type === 'battery').reduce((s, c) => s + (c.voltageValue ?? 0), 0);
    const maxI = Math.max(...Object.values(componentResults).map((r:any)=>Math.abs(r.current || 0)), 0);
    const totalP = Object.values(componentResults).reduce((s:any, r:any) => s + (r.power || 0), 0);
    const totalR = maxI > 1e-12 ? batterySum / maxI : 0;
    const summary = { totalVoltage: CircuitSolver.round(batterySum), totalCurrent: CircuitSolver.round(maxI), totalResistance: CircuitSolver.round(totalR), totalPower: CircuitSolver.round(totalP) };

    return { summary, componentResults, wireCurrents };
  }

  // 方便内部查找
  static _findComponentById(list: ComponentData[], id: string) { return list.find(c => c.id === id) || null; }
}

Page({
  data: {
    components: [] as ComponentData[],
    wires: [] as WireData[],
    circuitStatus: 'open',
    circuitStatusText: '电路开路',
    circuitSummary: { totalVoltage: 0, totalCurrent: 0, totalResistance: 0, totalPower: 0 } as CircuitSummary,
    selectedComponent: null as ComponentData | null,
    dragging: false,
    dragComponent: null as ComponentData | null,
    dragOffset: { x: 0, y: 0 } as DragOffset,
    workspaceRect: null as any,
    componentCounter: { resistor: 0, battery: 0, switch: 0, bulb: 0, motor: 0 } as Record<string, number>,
    connectingMode: false,
    selectedTerminal: null as SelectedTerminal | null,
    panelCollapsed: false,
    history: [] as any[],
    historyIndex: -1,
    maxHistory: 20,
    gridSnap: true,
    gridSize: 20,
    _updateTimer: null as any
  },

  onLoad() { console.log('电路模拟器页面加载'); this.saveState(); },
  onReady() { this.getWorkspaceRect(); },

  getWorkspaceRect() { const query = wx.createSelectorQuery(); query.select('#workspace').boundingClientRect(); query.exec((res: any[]) => { if (res && res[0]) this.setData({ workspaceRect: res[0] }); }); },

  addComponent(e: any) {
    const type = e.currentTarget.dataset.type as string;
    const counter = { ...this.data.componentCounter };
    counter[type] = (counter[type] || 0) + 1;
    const workspaceWidth = this.data.workspaceRect?.width ?? 300;
    const workspaceHeight = this.data.workspaceRect?.height ?? 300;
    let posX = workspaceWidth / 2 - 30 + (Math.random() - 0.5) * 100;
    let posY = workspaceHeight / 2 - 30 + (Math.random() - 0.5) * 100;
    if (this.data.gridSnap) { posX = this.snap(posX); posY = this.snap(posY); }
    const c: ComponentData = { id: `${type}_${Date.now()}`, type, label: `${this.nameOf(type)}${counter[type]}`, x: posX, y: posY, rotate: 0, zIndex: 1, selected: false, status: 'off', state: 'open', connectedTerminals: { 1: false, 2: false }, voltage: 0, current: 0, power: 0 };
    if (type === 'resistor') { c.resistance = 100; c.ratedPower = 0.25; }
    if (type === 'battery') { c.rotate = 90; c.voltageValue = 9; c.internalResistance = 0.1; }
    if (type === 'bulb') { c.bulbResistance = 10; c.ratedPower = 1; }
    if (type === 'motor') { c.motorResistance = 5; c.ratedPower = 1; }
    this.setData({ components: [...this.data.components, c], componentCounter: counter }, () => { this.checkCircuit(); this.saveState(); });
  },

  snap(v: number) { return Math.round(v / this.data.gridSize) * this.data.gridSize; },
  nameOf(type: string) { const m: any = { resistor: '电阻', battery: '电池', switch: '开关', bulb: '灯泡', motor: '电机' }; return m[type] ?? '未知'; },

  onTerminalTap(e: any) {
    const componentId = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || (e.target && e.target.dataset && e.target.dataset.id);
    const terminal = parseInt((e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.terminal) || (e.target && e.target.dataset && e.target.dataset.terminal) || '0', 10);
    if (!componentId) return;
    const component = this.data.components.find((c: ComponentData) => c.id === componentId);
    if (!component) return;
    if (component.connectedTerminals && component.connectedTerminals[terminal]) { wx.showToast({ title: '该端子已连接', icon: 'none' }); return; }
    const start = this.data.selectedTerminal;
    if (!start) {
      // 开始连接
      this.setData({ connectingMode: true, selectedTerminal: { componentId, terminal } });
      wx.showToast({ title: '请选择目标端子', icon: 'none' });
      return;
    }
    // 已有选中的起点，尝试创建连接
    if (start.componentId === componentId) {
      wx.showToast({ title: '不能连接自身', icon: 'none' });
      // 保持连接模式，取消选择起点
      this.setData({ selectedTerminal: null, connectingMode: false });
      return;
    }
    this.createWire(start, { componentId, terminal });
  },


  createWire(start: SelectedTerminal, end: SelectedTerminal) {
    const startComp = this.data.components.find((c: ComponentData) => c.id === start.componentId);
    const endComp = this.data.components.find((c: ComponentData) => c.id === end.componentId);
    if (!startComp || !endComp) return;
    const startPos = this.getTerminalPosition(startComp, start.terminal);
    const endPos = this.getTerminalPosition(endComp, end.terminal);
    const duplicate = this.data.wires.some((w: WireData) => ((w.startComponent === start.componentId && w.startTerminal === start.terminal && w.endComponent === end.componentId && w.endTerminal === end.terminal) || (w.startComponent === end.componentId && w.startTerminal === end.terminal && w.endComponent === start.componentId && w.endTerminal === start.terminal)));
    if (duplicate) { wx.showToast({ title: '该连接已存在', icon: 'none' }); this.setData({ connectingMode: false, selectedTerminal: null }); return; }
    const wire: WireData = { id: `wire_${Date.now()}`, start: startPos, end: endPos, length: Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y), angle: Math.atan2(endPos.y - startPos.y, endPos.x - startPos.x), startComponent: start.componentId, startTerminal: start.terminal, endComponent: end.componentId, endTerminal: end.terminal, current: 0 };
    const components = this.data.components.map((c: ComponentData) => { if (c.id === start.componentId) c = { ...c, connectedTerminals: { ...c.connectedTerminals, [start.terminal]: true } }; if (c.id === end.componentId) c = { ...c, connectedTerminals: { ...c.connectedTerminals, [end.terminal]: true } }; return c; });
    this.setData({ wires: [...this.data.wires, wire], components, connectingMode: false, selectedTerminal: null }, () => { this.checkCircuit(); this.saveState(); });
  },

  getTerminalPosition(component: ComponentData, terminal: number) {
    const { x, y, rotate, type } = component; let width = 60, height = 30; if (type === 'battery') { width = 40; height = 50; } if (type === 'bulb') { width = 50; height = 50; } if (type === 'motor') { width = 60; height = 40; }
    const centerX = x + width / 2, centerY = y + height / 2; const rad = rotate * Math.PI / 180; const offset = (Math.abs(Math.sin(rad)) > 0.7) ? { x: 0, y: terminal === 1 ? -height / 2 + 4 : height / 2 - 4 } : { x: terminal === 1 ? -width / 2 + 4 : width / 2 - 4, y: 0 };
    return { x: centerX + (offset.x * Math.cos(rad) - offset.y * Math.sin(rad)), y: centerY + (offset.x * Math.sin(rad) + offset.y * Math.cos(rad)) };
  },

  onComponentTouchStart(e: any) { const id = e.currentTarget.dataset.id as string; const comp = this.data.components.find((c: ComponentData) => c.id === id); if (!comp) return; const t = e.touches[0]; const components = this.data.components.map((c: ComponentData) => ({ ...c, selected: c.id === id, zIndex: c.id === id ? 10 : 1 })); this.setData({ dragging: true, dragComponent: comp, dragOffset: { x: t.clientX - comp.x, y: t.clientY - comp.y }, selectedComponent: comp, components }); },
  onComponentTouchMove(e: any) { if (!this.data.dragging || !this.data.dragComponent) return; const touch = e.changedTouches?.[0] || e.touches?.[0]; if (!touch) return; const rect = this.data.workspaceRect; if (!rect) return; let nx = touch.clientX - this.data.dragOffset.x, ny = touch.clientY - this.data.dragOffset.y; nx = Math.max(0, Math.min(nx, rect.width - 60)); ny = Math.max(0, Math.min(ny, rect.height - 60)); if (this.data.gridSnap) { nx = this.snap(nx); ny = this.snap(ny); } const id = this.data.dragComponent.id; const components = this.data.components.map((c: ComponentData) => c.id === id ? { ...c, x: nx, y: ny } : c); this.setData({ components, selectedComponent: components.find((c: ComponentData) => c.id === id) || null }); if (this.data._updateTimer) clearTimeout(this.data._updateTimer); this.data._updateTimer = setTimeout(() => this.updateWirePositions(), 50); },
  onComponentTouchEnd() { if (this.data.dragging) { this.setData({ dragging: false, dragComponent: null }); this.updateWirePositions(); this.saveState(); } },

  updateWirePositions() { const wires = this.data.wires.map((w: WireData) => { const s = this.data.components.find((c: ComponentData) => c.id === w.startComponent); const e = this.data.components.find((c: ComponentData) => c.id === w.endComponent); if (!s || !e) return w; const sp = this.getTerminalPosition(s, w.startTerminal); const ep = this.getTerminalPosition(e, w.endTerminal); return { ...w, start: sp, end: ep, length: Math.hypot(ep.x - sp.x, ep.y - sp.y), angle: Math.atan2(ep.y - sp.y, ep.x - sp.x) }; }); this.setData({ wires }, () => this.checkCircuit()); },

  deleteWire(id: string) { const wire = this.data.wires.find((w: WireData) => w.id === id); if (!wire) return; const wires = this.data.wires.filter((w: WireData) => w.id !== id); const components = this.data.components.map((c: ComponentData) => { const connectedTerminals: Record<number, boolean> = { 1: false, 2: false }; wires.forEach(w => { if (w.startComponent === c.id) connectedTerminals[w.startTerminal] = true; if (w.endComponent === c.id) connectedTerminals[w.endTerminal] = true; }); return { ...c, connectedTerminals }; }); this.setData({ wires, components }, () => { this.checkCircuit(); this.saveState(); }); },

  checkCircuit() {
    const { components, wires } = this.data;
    const zeroSummary = { totalVoltage: 0, totalCurrent: 0, totalResistance: 0, totalPower: 0 } as CircuitSummary;
    if (components.length === 0) {
      this.setData({ circuitStatus: 'open', circuitStatusText: '请添加元件', circuitSummary: zeroSummary });
      this.updateComponentResults({ summary: zeroSummary, componentResults: {}, wireCurrents: {} });
      return;
    }
    if (!components.some((c: ComponentData) => c.type === 'battery')) {
      this.setData({ circuitStatus: 'open', circuitStatusText: '请添加电池', circuitSummary: zeroSummary });
      this.updateComponentResults({ summary: zeroSummary, componentResults: {}, wireCurrents: {} });
      return;
    }
    if (wires.length === 0) {
      this.setData({ circuitStatus: 'open', circuitStatusText: '请连接元件', circuitSummary: zeroSummary });
      this.updateComponentResults({ summary: zeroSummary, componentResults: {}, wireCurrents: {} });
      return;
    }

    const result = CircuitSolver.analyze(components, wires);
    const raw = result.summary || zeroSummary;
    // 防护：确保 summary 字段为有限数值（避免 NaN/undefined 导致模板 toFixed 抛错或不显示）
    const safe = {
      totalVoltage: (raw && isFinite(raw.totalVoltage)) ? CircuitSolver.round(raw.totalVoltage) : 0,
      totalCurrent: (raw && isFinite(raw.totalCurrent)) ? CircuitSolver.round(raw.totalCurrent) : 0,
      totalResistance: (raw && isFinite(raw.totalResistance)) ? CircuitSolver.round(raw.totalResistance) : 0,
      totalPower: (raw && isFinite(raw.totalPower)) ? CircuitSolver.round(raw.totalPower) : 0,
      totalVoltageDisplay: ((raw && isFinite(raw.totalVoltage)) ? CircuitSolver.round(raw.totalVoltage) : 0).toFixed(2),
      totalCurrentDisplay: ((raw && isFinite(raw.totalCurrent)) ? CircuitSolver.round(raw.totalCurrent) : 0).toFixed(2),
      totalResistanceDisplay: ((raw && isFinite(raw.totalResistance)) ? CircuitSolver.round(raw.totalResistance) : 0).toFixed(2),
      totalPowerDisplay: ((raw && isFinite(raw.totalPower)) ? CircuitSolver.round(raw.totalPower) : 0).toFixed(2)
    } as any;

    if (safe.totalCurrent === 0) {
      this.setData({ circuitSummary: safe, circuitStatus: 'open', circuitStatusText: '电路开路' });
      console.log('checkCircuit: open summary=', safe, 'componentResults=', result.componentResults);
      this.updateComponentResults(result);
      return;
    }
    if (!isFinite(safe.totalCurrent) || Math.abs(safe.totalCurrent) > 1e8) {
      this.setData({ circuitSummary: safe, circuitStatus: 'short', circuitStatusText: '短路' });
      console.log('checkCircuit: short summary=', safe, 'componentResults=', result.componentResults);
      this.updateComponentResults(result);
      return;
    }
    this.setData({ circuitSummary: safe, circuitStatus: 'closed', circuitStatusText: '电路闭合' });
    console.log('checkCircuit: closed summary=', safe, 'componentResults=', result.componentResults);
    this.updateComponentResults(result);
  },




  updateComponentResults(arg1: any, arg2?: number) {
    // 支持两种调用：传入 analyzer 结果对象，或者传入 (totalVoltage, totalCurrent)
    if (arg1 && arg1.componentResults) {
      const compResults: Record<string, { voltage:number; current:number; power:number; status:string }> = arg1.componentResults || {};
      const wireCurrents: Record<string, number> = arg1.wireCurrents || {};
      const components = this.data.components.map((c: ComponentData) => {
        const r = compResults[c.id];
        if (!r) return { ...c, voltage: 0, current: 0, power: 0, status: 'off', voltageDisplay: '0.00', currentDisplay: '0.00', powerDisplay: '0.00' };
        const voltage = isFinite((r as any).voltage) ? (r as any).voltage : 0;
        const current = isFinite((r as any).current) ? (r as any).current : 0;
        const power = isFinite((r as any).power) ? (r as any).power : 0;
        const status = r.status || (Math.abs(current) > 1e-6 ? 'on' : 'off');
        return { ...c, voltage, current, power, status, voltageDisplay: voltage.toFixed(2), currentDisplay: current.toFixed(2), powerDisplay: power.toFixed(2) };
      });
      const wires = this.data.wires.map((w: WireData) => ({ ...w, current: isFinite(wireCurrents[w.id]) ? wireCurrents[w.id] : 0, currentDisplay: (isFinite(wireCurrents[w.id]) ? wireCurrents[w.id] : 0).toFixed(2) }));
      this.setData({ components, wires });
      console.log('updateComponentResults: components=', components.map(c=>({id:c.id,voltage:c.voltage,current:c.current,power:c.power,status:c.status,voltageDisplay:(c as any).voltageDisplay})), 'wires=', wires.map(w=>({id:w.id,current:w.current,currentDisplay:(w as any).currentDisplay})));
      return;
    }

    // 旧行为的回退：全体使用同一电流值
    const totalVoltage = arg1 as number || 0;
    const totalCurrent = arg2 || 0;
    const components = this.data.components.map((c: ComponentData) => {
      if (!c.connectedTerminals || (!c.connectedTerminals[1] && !c.connectedTerminals[2])) return { ...c, voltage: 0, current: 0, power: 0, status: 'off' };
      const r = CircuitAnalyzer.getComponentResistance(c);
      const voltage = CircuitAnalyzer.round(r * totalCurrent, 6);
      const power = CircuitAnalyzer.round(voltage * totalCurrent, 6);
      let status = 'off';
      if (totalCurrent > 1e-6) {
        if (c.type === 'bulb') status = 'on'; else if (c.type === 'motor') status = 'running'; else status = 'on';
      }
      return { ...c, voltage, current: totalCurrent, power, status };
    });
    const wires = this.data.wires.map((w: WireData) => ({ ...w, current: totalCurrent }));
    this.setData({ components, wires });
  },


  saveState() { const state = { components: JSON.parse(JSON.stringify(this.data.components)), wires: JSON.parse(JSON.stringify(this.data.wires)) }; let history = [...this.data.history]; let idx = this.data.historyIndex; history = history.slice(0, idx + 1); history.push(state); if (history.length > this.data.maxHistory) history.shift(); else idx++; this.setData({ history, historyIndex: idx }); },
  undo() { if (this.data.historyIndex <= 0) { wx.showToast({ title: '无法撤销', icon: 'none' }); return; } const idx = this.data.historyIndex - 1; const st = this.data.history[idx]; this.setData({ components: st.components, wires: st.wires, historyIndex: idx, selectedComponent: null, connectingMode: false, selectedTerminal: null }); },
  redo() { if (this.data.historyIndex >= this.data.history.length - 1) { wx.showToast({ title: '无法重做', icon: 'none' }); return; } const idx = this.data.historyIndex + 1; const st = this.data.history[idx]; this.setData({ components: st.components, wires: st.wires, historyIndex: idx, selectedComponent: null, connectingMode: false, selectedTerminal: null }); },

  rotateComponent() { if (!this.data.selectedComponent) return; const id = this.data.selectedComponent.id; const components = this.data.components.map((c: ComponentData) => c.id === id ? { ...c, rotate: (c.rotate + 90) % 360 } : c); this.setData({ components, selectedComponent: components.find((c: ComponentData) => c.id === id) || null }, () => { this.updateWirePositions(); this.saveState(); }); },
  deleteComponent() { if (!this.data.selectedComponent) return; wx.showModal({ title: '删除元件', content: '确定要删除选中的元件吗？', success: (res) => { if (res.confirm) this.performDelete(); } }); },
  performDelete() { if (!this.data.selectedComponent) return; const id = this.data.selectedComponent.id; const wires = this.data.wires.filter((w: WireData) => w.startComponent !== id && w.endComponent !== id); const components = this.data.components.filter((c: ComponentData) => c.id !== id).map((c: ComponentData) => { const connectedTerminals: Record<number, boolean> = { 1: false, 2: false }; wires.forEach(w => { if (w.startComponent === c.id) connectedTerminals[w.startTerminal] = true; if (w.endComponent === c.id) connectedTerminals[w.endTerminal] = true; }); return { ...c, connectedTerminals }; }); this.setData({ components, wires, selectedComponent: null }, () => { this.checkCircuit(); this.saveState(); }); },

  toggleSwitch() { if (!this.data.selectedComponent || this.data.selectedComponent.type !== 'switch') return; const id = this.data.selectedComponent.id; const components = this.data.components.map((c: ComponentData) => c.id === id ? { ...c, state: c.state === 'open' ? 'closed' : 'open' } : c); this.setData({ components, selectedComponent: components.find((c: ComponentData) => c.id === id) || null }, () => { this.checkCircuit(); this.saveState(); }); },
  updateComponentParam(param: string, value: any) { if (!this.data.selectedComponent) return; const f = parseFloat(value); if (isNaN(f) || f < 0) return; const id = this.data.selectedComponent.id; const components = this.data.components.map((c: ComponentData) => c.id === id ? { ...c, [param]: f } : c); this.setData({ components, selectedComponent: components.find((c: ComponentData) => c.id === id) || null }, () => { this.checkCircuit(); this.saveState(); }); },

  selectComponent(e: any) {
    const id = e.currentTarget.dataset.id as string;
    if (!id) return;
    const components = this.data.components.map((c: ComponentData) => ({ ...c, selected: c.id === id }));
    const selectedComponent = components.find((c: ComponentData) => c.id === id) || null;
    this.setData({ components, selectedComponent });
  },

  clearSelection() {
    const components = this.data.components.map((c: ComponentData) => ({ ...c, selected: false }));
    this.setData({ selectedComponent: null, components });
  },

  onResistanceChange(e: any) { const value = e.detail?.value ?? e.detail?.value; this.updateComponentParam('resistance', value); },
  setResistance(e: any) { const v = e.currentTarget.dataset.value; this.updateComponentParam('resistance', v); },

  onBatteryVoltageChange(e: any) { const v = e.detail?.value; this.updateComponentParam('voltageValue', v); },
  onBatteryInternalResistanceChange(e: any) { const v = e.detail?.value; this.updateComponentParam('internalResistance', v); },
  setBattery(e: any) { const v = parseFloat(e.currentTarget.dataset.voltage); if (isNaN(v)) return; const id = this.data.selectedComponent?.id; if (!id) return; const components = this.data.components.map(c => c.id === id ? { ...c, voltageValue: v } : c); this.setData({ components, selectedComponent: components.find(c=>c.id===id) || null }, () => { this.checkCircuit(); this.saveState(); }); },

  onBulbResistanceChange(e:any){ this.updateComponentParam('bulbResistance', e.detail?.value); },
  onBulbPowerChange(e:any){ this.updateComponentParam('ratedPower', e.detail?.value); },
  onMotorResistanceChange(e:any){ this.updateComponentParam('motorResistance', e.detail?.value); },
  onMotorPowerChange(e:any){ this.updateComponentParam('ratedPower', e.detail?.value); },

  showComponentInfo(e:any){
    const id = e.currentTarget.dataset.id as string;
    const comp = this.data.components.find(c=>c.id===id) || this.data.selectedComponent;
    let msg = comp ? `${this.nameOf(comp.type)} ${comp.label}\n` : '元件信息';
    if (comp) {
      msg += `参数:\n` + JSON.stringify({ resistance: comp.resistance, voltageValue: comp.voltageValue, internalResistance: comp.internalResistance, bulbResistance: comp.bulbResistance, motorResistance: comp.motorResistance, ratedPower: comp.ratedPower }, null, 2);
    }
    wx.showModal({ title: '说明', content: msg, showCancel: false });
  },

  startSimulation() { wx.showToast({ title: '开始模拟', icon: 'none' }); this.checkCircuit(); },
  onWorkspaceTouchStart(e:any) {
    // 如果触点来自某个元件或端子（有 dataset.id），不要清除连接状态
    const targetDatasetId = e?.target?.dataset?.id;
    if (targetDatasetId) return;
    // 只有在确实点击在工作区空白时才清除
    const currentId = e?.currentTarget?.id || '';
    if (currentId === 'workspace') {
      this.setData({ connectingMode: false, selectedTerminal: null });
    }
  },

  onWireTap(e:any) { const id = e.currentTarget.dataset.id as string; if (!id) return; wx.showModal({ title: '导线', content: '删除此导线？', success: (res)=>{ if (res.confirm) this.deleteWire(id); } }); },

  clearAll() { wx.showModal({ title: '确认', content: '确定要清空所有元件吗？', success: (res) => { if (res.confirm) { this.setData({ components: [], wires: [], selectedComponent: null, circuitStatus: 'open', circuitStatusText: '电路开路', circuitSummary: { totalVoltage: 0, totalCurrent: 0, totalResistance: 0, totalPower: 0 }, componentCounter: { resistor:0,battery:0,switch:0,bulb:0,motor:0 }, connectingMode: false, selectedTerminal: null }, () => { this.saveState(); wx.showToast({ title: '已清空', icon:'success' }); }); } } }); },

  getTerminalClass(component: ComponentData, terminal: number) {
    if (this.data.connectingMode && this.data.selectedTerminal && this.data.selectedTerminal.componentId === component.id && this.data.selectedTerminal.terminal === terminal) return 'selected-terminal';
    if (component.connectedTerminals && component.connectedTerminals[terminal]) return 'connected';
    return '';
  },

  getComponentChineseName(type: string) { return this.nameOf(type); },

  togglePanel() { this.setData({ panelCollapsed: !this.data.panelCollapsed }); },

  onUnload() { if (this.data._updateTimer) { clearTimeout(this.data._updateTimer); this.data._updateTimer = null; } }
});
