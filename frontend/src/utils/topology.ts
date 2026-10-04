/**
 * 闸门串级（拓扑）计算工具
 *
 * - 沿「非关闭」闸门追踪某口池的连续下游路线（同池系优先）；
 * - 路线经过停用池或找不到连续下游时，给出待确认原因；
 * - 临时换线时为每条走水计划规划新路线与全局次序；
 * - 换线规划是纯函数，db 层只负责把规划结果写进事务，
 *   页面预览与实际提交因此使用同一份逻辑、结果一致。
 */
import type { Pond, PondStatus } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Schedule } from '../types/schedule';
import { LOCKED_STATES } from '../types/schedule';
import type { PendingReason, SwitchDraftGate, TopologyVersion } from '../types/topology';
import { INITIAL_TOPOLOGY_ID } from '../types/topology';

/** 路线上只允许穿过该状态的池；停用会截断、清池中允许通过 */
const PASSABLE_STATUS: ReadonlySet<PondStatus> = new Set<PondStatus>(['在用', '清池中']);

/** 路线追踪结果 */
export interface RouteTrace {
  /** 经过的池 id 链（含起点） */
  path: string[];
  /** 终点池 id；路线待确认时为 null */
  terminalPondId: string | null;
  /** 待确认原因；null 表示路线完整 */
  pendingReason: PendingReason | null;
}

/** 某拓扑版本下的闸门集合 */
export function gatesOfVersion(gates: readonly Gate[], versionId: number): Gate[] {
  return gates.filter((gate) => gate.topologyVersionId === versionId);
}

/** 当前生效拓扑版本（id 最大者） */
export function activeTopology(versions: readonly TopologyVersion[]): TopologyVersion | null {
  if (versions.length === 0) return null;
  return versions.reduce((acc, item) => (item.id > acc.id ? item : acc));
}

/**
 * 从 sourcePondId 出发沿连续下游追踪路线。
 * 每一跳：同池系非关闭闸优先，其次开度、口宽、下游池号；
 * 走过的池不再回头，避免成环死循环。
 */
export function traceRoute(
  sourcePondId: string,
  gates: readonly Gate[],
  ponds: readonly Pond[],
): RouteTrace {
  const pondMap = new Map(ponds.map((pond) => [pond.id, pond]));
  const source = pondMap.get(sourcePondId);
  if (source === undefined || !PASSABLE_STATUS.has(source.status)) {
    // 起点本身已停用：没有可用下游，直接留在待确认区
    return { path: source === undefined ? [] : [sourcePondId], terminalPondId: null, pendingReason: '经过停用池' };
  }

  const path: string[] = [sourcePondId];
  const visited = new Set<string>([sourcePondId]);
  let current = sourcePondId;

  for (;;) {
    const currentPond = pondMap.get(current);
    const sameSeries = currentPond?.seriesName ?? '';
    const candidates = gates
      .filter(
        (gate) =>
          gate.fromPondId === current &&
          gate.state !== '关闭' &&
          gate.openingPct > 0 &&
          pondMap.has(gate.toPondId) &&
          !visited.has(gate.toPondId),
      )
      .sort((a, b) => {
        const pa = pondMap.get(a.toPondId);
        const pb = pondMap.get(b.toPondId);
        const sameA = pa?.seriesName === sameSeries ? 1 : 0;
        const sameB = pb?.seriesName === sameSeries ? 1 : 0;
        if (sameA !== sameB) return sameB - sameA;
        if (b.openingPct !== a.openingPct) return b.openingPct - a.openingPct;
        if (b.widthCm !== a.widthCm) return b.widthCm - a.widthCm;
        return (pa?.code ?? '').localeCompare(pb?.code ?? '', 'zh-Hans-CN');
      });

    const nextGate = candidates[0];
    if (nextGate === undefined) {
      // 没有连续下游：正常终点 vs 待确认，看起点之后是否走出过任何一跳
      if (path.length === 1) {
        return { path, terminalPondId: null, pendingReason: '找不到连续下游' };
      }
      return { path, terminalPondId: current, pendingReason: null };
    }

    const nextPond = pondMap.get(nextGate.toPondId);
    if (nextPond === undefined) {
      return { path, terminalPondId: null, pendingReason: '找不到连续下游' };
    }
    path.push(nextPond.id);
    visited.add(nextPond.id);
    if (!PASSABLE_STATUS.has(nextPond.status)) {
      // 终点落在停用池：路线在此截断，进入待确认区
      return { path, terminalPondId: null, pendingReason: '经过停用池' };
    }
    current = nextPond.id;
  }
}

/** 路线在池系链上的深度（起点为 0）；待确认路线排到正常路线之后 */
export function routeDepth(trace: Pick<RouteTrace, 'path' | 'pendingReason'>): number {
  return trace.pendingReason === null ? Math.max(0, trace.path.length - 1) : 999;
}

/** 路线字段集合：新建 / 编辑走水计划时按当前拓扑补齐 */
export interface RouteFields {
  routeVersionId: number;
  routePath: string[] | null;
  terminalPondId: string | null;
  pendingReason: PendingReason | null;
  routeLocked: boolean;
}

/**
 * 为一条走水计划补齐路线字段。
 * - 已开始 / 已出卤：按依据版本锁定原路线（找不到闸门链也照样锁定）；
 * - 未开始：按依据版本重算，路线走不通就带待确认原因。
 */
export function resolveRouteFields(
  sourcePondId: string,
  state: Schedule['state'],
  versionId: number,
  gates: readonly Gate[],
  ponds: readonly Pond[],
): RouteFields {
  const locked = LOCKED_STATES.includes(state);
  const versionGates = gatesOfVersion(gates, versionId);
  const trace = traceRoute(sourcePondId, versionGates, ponds);
  return {
    routeVersionId: versionId,
    routePath: trace.path.length > 0 ? trace.path : null,
    terminalPondId: trace.terminalPondId,
    pendingReason: locked ? null : trace.pendingReason,
    routeLocked: locked,
  };
}

/** 换线规划中每条计划的处理动作 */
export type SwitchPlanAction = '锁定原路线' | '按新拓扑重算' | '进入待确认区';

/** 换线规划结果（单条计划） */
export interface SwitchPlan {
  scheduleId: string;
  pondId: string;
  planDate: string;
  state: Schedule['state'];
  seriesName: string;
  oldOrderIndex: number;
  action: SwitchPlanAction;
  /** 规划后使用的版本（锁定项保留旧版本，其余指向新版本） */
  routeVersionId: number;
  routePath: string[] | null;
  terminalPondId: string | null;
  pendingReason: PendingReason | null;
  routeLocked: boolean;
  /** 排序键：路线深度 + 日期 + 旧次序 */
  depth: number;
  /** 重排后的全局次序 */
  newOrderIndex: number;
}

/** 换线规划入参 */
export interface SwitchoverInput {
  schedules: readonly Schedule[];
  ponds: readonly Pond[];
  /** 生效中的全部闸门（含历史版本，供锁定批次回放旧路线） */
  gates: readonly Gate[];
  /** 候选拓扑闸门（编辑后的新拓扑） */
  candidateGates: readonly Gate[];
  newVersionId: number;
}

/**
 * 纯函数：按新拓扑规划全部走水计划。
 * 已开始 / 已出卤的批次锁定原路线，未开始的按新拓扑重算终点，
 * 走不通的进入待确认区；最后按「池系链深度 → 日期 → 旧次序」
 * 统一重排全局 orderIndex。
 */
export function planSwitchover(input: SwitchoverInput): SwitchPlan[] {
  const { schedules, ponds, gates, candidateGates, newVersionId } = input;
  const plans: SwitchPlan[] = schedules.map((schedule) => {
    const pond = ponds.find((item) => item.id === schedule.pondId);
    const seriesName = pond?.seriesName ?? '未分配池系';
    const locked = LOCKED_STATES.includes(schedule.state);
    let trace: RouteTrace;
    let versionId: number;
    if (locked) {
      versionId = schedule.routeVersionId || INITIAL_TOPOLOGY_ID;
      trace = traceRoute(schedule.pondId, gatesOfVersion(gates, versionId), ponds);
    } else {
      versionId = newVersionId;
      trace = traceRoute(schedule.pondId, candidateGates, ponds);
    }
    const action: SwitchPlanAction = locked
      ? '锁定原路线'
      : trace.pendingReason === null
        ? '按新拓扑重算'
        : '进入待确认区';
    return {
      scheduleId: schedule.id,
      pondId: schedule.pondId,
      planDate: schedule.planDate,
      state: schedule.state,
      seriesName,
      oldOrderIndex: schedule.orderIndex,
      action,
      routeVersionId: versionId,
      routePath: trace.path.length > 0 ? trace.path : null,
      terminalPondId: trace.terminalPondId,
      pendingReason: locked ? null : trace.pendingReason,
      routeLocked: locked,
      depth: routeDepth(trace),
      newOrderIndex: 0,
    };
  });

  plans.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.planDate.localeCompare(b.planDate, 'zh-Hans-CN') ||
      a.oldOrderIndex - b.oldOrderIndex ||
      a.scheduleId.localeCompare(b.scheduleId),
  );
  plans.forEach((plan, index) => {
    plan.newOrderIndex = index + 1;
  });
  return plans;
}

/**
 * 按某拓扑版本复查未锁定计划的路线与全局次序。
 * 用于：拓扑没有再变时，对待确认项做人工重算；
 * 已锁定批次仍留在原位。
 */
export interface RecheckInput {
  schedules: readonly Schedule[];
  ponds: readonly Pond[];
  gates: readonly Gate[];
  versionId: number;
}

export interface RecheckResult {
  scheduleId: string;
  planDate: string;
  routeVersionId: number;
  routePath: string[] | null;
  terminalPondId: string | null;
  pendingReason: PendingReason | null;
  routeLocked: boolean;
  oldOrderIndex: number;
  newOrderIndex: number;
  depth: number;
}

export function recheckPlans(input: RecheckInput): RecheckResult[] {
  const { schedules, ponds, gates, versionId } = input;
  const versionGates = gatesOfVersion(gates, versionId);
  const results = schedules.map((schedule) => {
    const locked = LOCKED_STATES.includes(schedule.state);
    const trace = locked
      ? traceRoute(schedule.pondId, gatesOfVersion(gates, schedule.routeVersionId || versionId), ponds)
      : traceRoute(schedule.pondId, versionGates, ponds);
    return {
      scheduleId: schedule.id,
      planDate: schedule.planDate,
      routeVersionId: locked ? schedule.routeVersionId || versionId : versionId,
      routePath: trace.path.length > 0 ? trace.path : null,
      terminalPondId: trace.terminalPondId,
      pendingReason: locked ? null : trace.pendingReason,
      routeLocked: locked,
      oldOrderIndex: schedule.orderIndex,
      newOrderIndex: 0,
      depth: routeDepth(trace),
    };
  });
  results.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.planDate.localeCompare(b.planDate, 'zh-Hans-CN') ||
      a.oldOrderIndex - b.oldOrderIndex ||
      a.scheduleId.localeCompare(b.scheduleId),
  );
  results.forEach((item, index) => {
    item.newOrderIndex = index + 1;
  });
  return results;
}

/** 候选闸门的校验问题 */
export interface GateValidationIssue {
  draftId: string;
  message: string;
}

type CandidateGateShape = {
  draftId?: string;
  id?: string;
  fromPondId: string;
  toPondId: string;
};

/** 提交前校验候选闸门：缺失端点、自环、重复串级一律不允许提交 */
export function validateCandidateGates(
  candidateGates: readonly CandidateGateShape[],
  ponds: readonly Pond[],
): GateValidationIssue[] {
  const issues: GateValidationIssue[] = [];
  const pondIds = new Set(ponds.map((pond) => pond.id));
  const seen = new Set<string>();
  for (const gate of candidateGates) {
    const draftId = gate.draftId ?? gate.id ?? '';
    if (!pondIds.has(gate.fromPondId) || !pondIds.has(gate.toPondId)) {
      issues.push({ draftId, message: '上 / 下游池不存在（可能已被删除）' });
      continue;
    }
    if (gate.fromPondId === gate.toPondId) {
      issues.push({ draftId, message: '上游池与下游池不能是同一口池' });
      continue;
    }
    const key = `${gate.fromPondId}→${gate.toPondId}`;
    if (seen.has(key)) {
      issues.push({ draftId, message: `重复串级 ${key}` });
    }
    seen.add(key);
  }
  return issues;
}

/** 从生效闸门克隆一份换线工作副本 */
export function cloneGatesToDraft(gates: readonly Gate[]): SwitchDraftGate[] {
  return gates.map((gate) => ({
    draftId: gate.id,
    sourceGateId: gate.id,
    fromPondId: gate.fromPondId,
    toPondId: gate.toPondId,
    openingPct: gate.openingPct,
    widthCm: gate.widthCm,
    state: gate.state,
    note: gate.note,
    removed: false,
  }));
}

/** 路线版本短标签，如「路线 v2」 */
export function routeVersionLabel(versionId: number): string {
  return `路线 v${versionId}`;
}

/** 路线池号链文本，如「北-01 → 北-02 → 北-03」 */
export function routeChainText(path: readonly string[] | null, ponds: readonly Pond[]): string {
  if (path === null || path.length === 0) return '路线待确认';
  const map = new Map(ponds.map((pond) => [pond.id, pond.code]));
  return path.map((id) => map.get(id) ?? '（池已删除）').join(' → ');
}
