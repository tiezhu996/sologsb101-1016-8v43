/**
 * 串级拓扑与换线推演（纯函数）
 * - 从任一池沿闸门追踪连续下游（忽略关闭闸门）
 * - 判定停用池 / 断链 / 成环 / 分支，给出待确认原因
 * - 换线提交前按池系列出受影响计划：锁定原路线 / 按新拓扑重算 / 待确认
 * - 对未开始计划按新拓扑重算终点与次序（受影响计划连续成块，块内按串级深度排）
 */
import type { Gate } from '../types/gate';
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import type { LineChangeGateDraft } from '../types/lineChange';

/** 拓扑推演所需的最小闸门结构 */
export interface GateLike {
  id: string
  fromPondId: string
  toPondId: string
  openingPct: number
  state: Gate['state']
}

export interface RouteTraceResult {
  ok: boolean
  /** 途经池 id 链，含起点与终点 */
  path: string[]
  /** 终点池 id；起点不存在或起点即停用时为 '' */
  endPondId: string
  /** 不可走原因（ok=false 时给出） */
  issue: string
  /** 串级深度（途经闸门数），用于未开始计划重排序 */
  depth: number
  /** 推演过程中是否遇到多个开启的下游闸（按开度取最大者继续，但给出提示） */
  branched: boolean
}

/** 闸门是否可过流：关闭 / 开度 0 视为断链 */
export function isGateOpen(gate: Pick<GateLike, 'state' | 'openingPct'>): boolean {
  return gate.state !== '关闭' && gate.openingPct > 0;
}

/**
 * 从起点池开始追踪连续下游。
 * - 起点池不存在 / 停用：待确认
 * - 经过停用池：待确认
 * - 没有开启的下游闸：可走，终点即当前池（本池走水后就地晒制）
 * - 多个开启下游闸：按开度最大者继续（开度相同取 id 排序靠前者，保证推演确定）
 * - 串级成环：待确认
 */
export function traceRoute(
  startPondId: string,
  gates: GateLike[],
  ponds: Pond[],
): RouteTraceResult {
  const pondMap = new Map(ponds.map((pond) => [pond.id, pond]));
  const start = pondMap.get(startPondId);
  if (start === undefined) {
    return { ok: false, path: [], endPondId: '', issue: '起点池不存在或已删除', depth: 0, branched: false };
  }
  if (start.status === '停用') {
    return { ok: false, path: [startPondId], endPondId: '', issue: `起点池 ${start.code} 已停用`, depth: 0, branched: false };
  }

  const path: string[] = [startPondId];
  const visited = new Set<string>([startPondId]);
  let branched = false;
  let currentId = startPondId;

  for (;;) {
    const candidates = gates.filter((gate) => gate.fromPondId === currentId && isGateOpen(gate));
    if (candidates.length === 0) {
      return { ok: true, path, endPondId: currentId, issue: '', depth: path.length - 1, branched };
    }
    if (candidates.length > 1) branched = true;
    candidates.sort((a, b) => b.openingPct - a.openingPct || a.toPondId.localeCompare(b.toPondId) || a.id.localeCompare(b.id));
    const next = candidates[0];
    const nextPond = pondMap.get(next.toPondId);
    if (nextPond === undefined) {
      path.push(next.toPondId);
      return {
        ok: false,
        path,
        endPondId: '',
        issue: '下游池不存在或已删除，找不到连续下游',
        depth: path.length - 1,
        branched,
      };
    }
    if (nextPond.status === '停用') {
      path.push(next.toPondId);
      return {
        ok: false,
        path,
        endPondId: '',
        issue: `路线经过停用池 ${nextPond.code}`,
        depth: path.length - 1,
        branched,
      };
    }
    if (visited.has(next.toPondId)) {
      path.push(next.toPondId);
      return {
        ok: false,
        path,
        endPondId: '',
        issue: `串级成环：${nextPond.code} 已在路线中，找不到连续下游`,
        depth: path.length - 1,
        branched,
      };
    }
    path.push(next.toPondId);
    visited.add(next.toPondId);
    currentId = next.toPondId;
    if (path.length > ponds.length + 1) {
      return { ok: false, path, endPondId: '', issue: '串级链异常过长，疑似成环', depth: path.length - 1, branched };
    }
  }
}

/** 计划分区：锁定原路线 / 按新拓扑重算 / 待确认 */
export type PlanZone = 'locked' | 'recompute' | 'pending';

export interface LineChangePlanView {
  schedule: Schedule
  zone: PlanZone
  oldTrace: RouteTraceResult
  newTrace: RouteTraceResult
  /** 新拓扑下是否与原路线一致（用于页面标注“路线不变”） */
  unchanged: boolean
  /** 块内次序（仅 recompute 区使用） */
  newOrderIndex: number
}

export interface LineChangeAnalysis {
  /** 该池系下的全部受影响计划（锁定 + 重算 + 待确认） */
  plans: LineChangePlanView[]
  locked: LineChangePlanView[]
  recompute: LineChangePlanView[]
  pending: LineChangePlanView[]
  /** 草稿闸门本身的校验错误（闸门行级，无法提交） */
  errors: string[]
}

/** 草稿行转拓扑推演用闸门 */
export function draftToGateLike(row: LineChangeGateDraft): GateLike {
  return {
    id: row.gateId === '' ? `new::${row.clientId}` : row.gateId,
    fromPondId: row.fromPondId,
    toPondId: row.toPondId,
    openingPct: row.openingPct,
    state: row.state,
  };
}

/**
 * 换线提交前的影响分析（按池系）。
 * @param seriesName 目标池系
 * @param draftGates 草稿中未删除的闸门行
 * @param oldGates 当前在用版本的全部闸门（池系内闸门会被草稿替换）
 */
export function analyzeLineChange(params: {
  seriesName: string
  draftGates: LineChangeGateDraft[]
  oldGates: Gate[]
  ponds: Pond[]
  schedules: Schedule[]
}): LineChangeAnalysis {
  const { seriesName, draftGates, oldGates, ponds, schedules } = params;

  const errors: string[] = [];
  // 池系范围：上游池属于该池系的闸门（删除 / 替换口径），其余闸门原样保留。
  // 草稿中池系外的旧闸门行与上游不属于本系的新增行一律忽略，防御越界行串入其他池系。
  const inScopeGateIds = new Set(
    oldGates
      .filter((gate) => ponds.find((pond) => pond.id === gate.fromPondId)?.seriesName === seriesName)
      .map((gate) => gate.id),
  );
  const scopedRows = draftGates.filter(
    (row) =>
      !row.removed &&
      (inScopeGateIds.has(row.gateId) ||
        (row.gateId === '' && ponds.find((pond) => pond.id === row.fromPondId)?.seriesName === seriesName)),
  );
  scopedRows.forEach((row) => {
    if (row.fromPondId === '' || row.toPondId === '') {
      errors.push(`存在未选择上游或下游的闸门行（${row.gateId === '' ? '新增闸' : `闸门 ${row.gateId}`}）`);
    } else if (row.fromPondId === row.toPondId) {
      errors.push(`闸门上下游不能是同一口池（${ponds.find((pond) => pond.id === row.fromPondId)?.code ?? row.fromPondId}）`);
    }
  });
  const keySet = new Set<string>();
  scopedRows.forEach((row) => {
    if (row.fromPondId === '' || row.toPondId === '') return;
    const key = `${row.fromPondId}->${row.toPondId}`;
    if (keySet.has(key)) errors.push(`重复的串级走向：${key}（同一上游到同一下游只能保留一条闸）`);
    keySet.add(key);
  });

  // 池系外闸门原样保留；池系内闸门以草稿作用域行为准
  const keptOutside = oldGates.filter((gate) => !inScopeGateIds.has(gate.id));
  const mergedGates: GateLike[] = [
    ...keptOutside.map((gate) => ({
      id: gate.id,
      fromPondId: gate.fromPondId,
      toPondId: gate.toPondId,
      openingPct: gate.openingPct,
      state: gate.state,
    })),
    ...scopedRows.map(draftToGateLike),
  ];

  const pondMap = new Map(ponds.map((pond) => [pond.id, pond]));
  const seriesSchedule = schedules.filter((row) => pondMap.get(row.pondId)?.seriesName === seriesName);

  const views: LineChangePlanView[] = seriesSchedule.map((schedule) => {
    const oldTrace = traceRoute(schedule.pondId, oldGates, ponds);
    const newTrace = traceRoute(schedule.pondId, mergedGates, ponds);
    // 已开始走水或已出卤：锁定原路线；未开始（待排 / 已排）：按新拓扑重算
    const started = schedule.state === '走水中' || schedule.state === '已出卤';
    const zone: PlanZone = started
      ? 'locked'
      : newTrace.ok
        ? 'recompute'
        : 'pending';
    const oldPathKey = oldTrace.path.join('>');
    const newPathKey = newTrace.path.join('>');
    return {
      schedule,
      zone,
      oldTrace,
      newTrace,
      unchanged: oldPathKey === newPathKey && oldTrace.ok === newTrace.ok,
      newOrderIndex: 0,
    };
  });

  // 未开始且可走的计划，按新拓扑串级深度（浅→深）、计划日期、原次序在块内排序
  const recompute = views
    .filter((view) => view.zone === 'recompute')
    .sort(
      (a, b) =>
        a.newTrace.depth - b.newTrace.depth ||
        a.schedule.planDate.localeCompare(b.schedule.planDate) ||
        a.schedule.orderIndex - b.schedule.orderIndex,
    );
  recompute.forEach((view, index) => {
    view.newOrderIndex = index + 1;
  });

  return {
    plans: views,
    locked: views.filter((view) => view.zone === 'locked'),
    recompute,
    pending: views.filter((view) => view.zone === 'pending'),
    errors,
  };
}

/**
 * 换线后重排全部计划的全局次序：
 * 受影响的未开始可走计划连续成块（最早原次序位置），块内按新串级深度；
 * 锁定、待确认与池系外计划保持原相对次序。
 * @returns 全量 schedule id 的新次序
 */
export function resequenceSchedules(allSchedules: Schedule[], affectedIds: Set<string>): string[] {
  const ordered = [...allSchedules].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
  const blockStart = ordered.findIndex((row) => affectedIds.has(row.id));
  if (blockStart === -1) return ordered.map((row) => row.id);

  const block = ordered
    .filter((row) => affectedIds.has(row.id))
    .sort(
      (a, b) =>
        (a.routePath.length || 0) - (b.routePath.length || 0) ||
        a.planDate.localeCompare(b.planDate) ||
        a.orderIndex - b.orderIndex,
    )
    .map((row) => row.id);
  const outside = ordered.filter((row) => !affectedIds.has(row.id)).map((row) => row.id);
  return [...outside.slice(0, blockStart), ...block, ...outside.slice(blockStart)];
}

/** 把池 id 链渲染为“北-01 → 北-02 → 北-03”，未知池回退为原 id */
export function routePathText(path: string[], ponds: Pond[]): string {
  if (path.length === 0) return '—';
  const pondMap = new Map(ponds.map((pond) => [pond.id, pond]));
  return path
    .map((id) => {
      const pond = pondMap.get(id);
      return pond === undefined ? `（${id}）` : pond.code;
    })
    .join(' → ');
}
