/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：闸门串级版本化，新增 topologyVersions / switchDrafts 表；
 *   闸门归属拓扑版本，走水计划携带路线版本、锁定路线与待确认原因
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import { LOCKED_STATES } from '../types/schedule';
import type { SwitchDraft, TopologyVersion } from '../types/topology';
import { INITIAL_TOPOLOGY_ID } from '../types/topology';
import { estimateEvapMm } from './brine';
import {
  gatesOfVersion,
  planSwitchover,
  resolveRouteFields,
  traceRoute,
  validateCandidateGates,
} from './topology';
import type { RouteFields } from './topology';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** 换线草稿在 switchDrafts 表中的固定单行主键 */
export const SWITCH_DRAFT_ID = 'active-switch-draft';

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  topologyVersions!: Table<TopologyVersion, number>;
  switchDrafts!: Table<SwitchDraft, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
      gates: 'id, fromPondId, toPondId, state, openingPct',
      observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
      assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v3：闸门串级版本化 + 走水计划路线版本 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct, topologyVersionId',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, routeVersionId, pendingReason, routeLocked',
        topologyVersions: 'id, appliedAt',
        switchDrafts: 'id, updatedAt',
      })
      .upgrade(async (tx) => {
        // 迁移 1（继承 v2）：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2（继承 v2）：卤水观测新增 evapMm
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3（继承 v2）：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4（继承 v2）：走水编排补齐排序序号
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });

        // ---- v3 新增：用现有闸门建立初始拓扑版本 ----
        const [legacyPonds, legacyGates] = await Promise.all([
          tx.table('ponds').toArray() as Promise<Pond[]>,
          tx.table('gates').toArray() as Promise<Gate[]>,
        ]);
        const stamp = nowIso();
        const initialVersion: TopologyVersion = {
          id: INITIAL_TOPOLOGY_ID,
          name: '初始串级 v1',
          note: '升级到 v3 时由现有闸门串级自动建立',
          operator: '',
          appliedAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        await tx.table('topologyVersions').put(initialVersion);
        await tx.table('gates').toCollection().modify((row: Record<string, unknown>) => {
          row.topologyVersionId = INITIAL_TOPOLOGY_ID;
        });

        // 已开始 / 已出卤批次锁定初始路线，未开始计划按初始拓扑补算。
        // 此时旧闸门的 topologyVersionId 标记尚未落到快照（modify 在集合遍历后才统一生效），
        // 因此直接用 legacyGates 全量作为初始拓扑闸门追踪。
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          const state = (typeof row.state === 'string' ? row.state : '待排') as ScheduleState;
          const sourcePondId = typeof row.pondId === 'string' ? row.pondId : '';
          const locked = LOCKED_STATES.includes(state);
          const trace = traceRoute(sourcePondId, legacyGates, legacyPonds);
          const fields: RouteFields = {
            routeVersionId: INITIAL_TOPOLOGY_ID,
            routePath: trace.path.length > 0 ? trace.path : null,
            terminalPondId: trace.terminalPondId,
            pendingReason: locked ? null : trace.pendingReason,
            routeLocked: locked,
          };
          row.routeVersionId = fields.routeVersionId;
          row.routePath = fields.routePath;
          row.terminalPondId = fields.terminalPondId;
          row.pendingReason = fields.pendingReason;
          row.routeLocked = fields.routeLocked;
        });
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/** 兜底：任何缺拓扑版本的数据（旧存档导入 / 播种场景）都补一个初始版本 */
export async function ensureInitialTopology(): Promise<TopologyVersion> {
  const existing = await db.topologyVersions.get(INITIAL_TOPOLOGY_ID);
  if (existing !== undefined) return existing;
  const stamp = nowIso();
  const version: TopologyVersion = {
    id: INITIAL_TOPOLOGY_ID,
    name: '初始串级 v1',
    note: '由现有闸门串级建立',
    operator: '',
    appliedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.topologyVersions.put(version);
  return version;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验与走水计划 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.topologyVersions, db.switchDrafts],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
      // 池删除后可能让候选拓扑 / 已编排计划失去连续下游：清掉未提交草稿，
      // 并让未开始计划按当前拓扑重新计算路线
      await db.switchDrafts.clear();
      await recalcUnlockedRoutesInTx();
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ----------------------------- 拓扑版本 / 换线 ----------------------------- */

export async function listTopologyVersions(): Promise<TopologyVersion[]> {
  const rows = await db.topologyVersions.toArray();
  return rows.sort((a, b) => a.id - b.id);
}

export async function getSwitchDraft(): Promise<SwitchDraft | null> {
  return (await db.switchDrafts.get(SWITCH_DRAFT_ID)) ?? null;
}

export async function putSwitchDraft(draft: SwitchDraft): Promise<void> {
  await db.switchDrafts.put({ ...draft, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function clearSwitchDraft(): Promise<void> {
  await db.switchDrafts.delete(SWITCH_DRAFT_ID);
}

/** 换线提交入参（候选闸门由工作副本转换而来） */
export interface CommitSwitchoverInput {
  note: string;
  operator: string;
  candidateGates: Gate[];
}

/**
 * 提交临时换线（单事务，任一步失败整笔回滚到原拓扑）：
 * 1. 新建拓扑版本并写入候选闸门；
 * 2. 已开始 / 已出卤批次锁定旧版本路线，未开始计划按新拓扑重算终点；
 *    经过停用池或找不到连续下游的进入待确认区；
 * 3. 按「池系链深度 → 日期 → 旧次序」重排全部计划次序；
 * 4. 删除未提交的换线草稿。
 */
export async function commitSwitchover(input: CommitSwitchoverInput): Promise<TopologyVersion> {
  return db.transaction(
    'rw',
    [db.topologyVersions, db.gates, db.schedules, db.ponds, db.switchDrafts],
    async () => {
      const [versions, gates, schedules, ponds] = await Promise.all([
        db.topologyVersions.toArray(),
        db.gates.toArray(),
        db.schedules.toArray(),
        db.ponds.toArray(),
      ]);
      // 服务端等价校验：自环 / 缺失端点 / 重复串级直接抛错，事务回滚原拓扑
      const issues = validateCandidateGates(input.candidateGates, ponds);
      if (issues.length > 0) {
        throw new Error(`候选拓扑校验未通过：${issues.map((item) => item.message).join('；')}`);
      }
      const newVersionId = versions.reduce((max, item) => Math.max(max, item.id), 0) + 1;
      const stamp = nowIso();
      const version: TopologyVersion = {
        id: newVersionId,
        name: `临时换线 v${newVersionId}`,
        note: input.note.trim(),
        operator: input.operator.trim(),
        appliedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await db.topologyVersions.put(version);

      // 新拓扑闸门整批发新 id（gates 主键是 id，沿用旧 id 会覆盖旧版本行）：
      // 已有闸门映射为 v{版本}-{原id}，工作区新增闸门（draft-gate- 前缀）发随机 id。
      // 路线追踪只依赖池连接与 topologyVersionId，与闸门 id 无关。
      const persistedGates: Gate[] = input.candidateGates.map((gate) => ({
        ...gate,
        id: gate.id.startsWith('draft-gate-') ? uuid('gate') : `v${newVersionId}-${gate.id}`,
        topologyVersionId: newVersionId,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }));
      await db.gates.bulkPut(persistedGates);

      const plans = planSwitchover({ schedules, ponds, gates, candidateGates: persistedGates, newVersionId });
      for (const plan of plans) {
        await db.schedules.update(plan.scheduleId, {
          routeVersionId: plan.routeVersionId,
          routePath: plan.routePath,
          terminalPondId: plan.terminalPondId,
          pendingReason: plan.pendingReason,
          routeLocked: plan.routeLocked,
          orderIndex: plan.newOrderIndex,
          updatedAt: stamp,
        });
      }

      await db.switchDrafts.clear();
      return version;
    },
  );
}

/**
 * 在拓扑未变的情况下复查待确认计划：停用池恢复 / 闸门补好后，
 * 未开始计划重新计算路线，仍走不通的继续留在待确认区；
 * 已锁定批次的路线与次序都保持不动。
 */
export async function recheckPendingSchedules(): Promise<number> {
  return db.transaction('rw', db.schedules, db.gates, db.ponds, db.topologyVersions, async () => {
    const [versions, gates, schedules, ponds] = await Promise.all([
      db.topologyVersions.toArray(),
      db.gates.toArray(),
      db.schedules.toArray(),
      db.ponds.toArray(),
    ]);
    const activeId = versions.reduce((max, item) => Math.max(max, item.id), INITIAL_TOPOLOGY_ID);
    const stamp = nowIso();
    const versionGates = gatesOfVersion(gates, activeId);

    let cleared = 0;
    // 锁定项位置不动；未开始项按「深度 → 日期 → 旧次序」排序后填回剩余槽位
    const unlocked: Array<{ schedule: Schedule; fields: ReturnType<typeof resolveRouteFields>; depth: number }> = [];
    for (const schedule of schedules) {
      if (LOCKED_STATES.includes(schedule.state)) continue;
      const trace = traceRoute(schedule.pondId, versionGates, ponds);
      const fields = {
        routeVersionId: activeId,
        routePath: trace.path.length > 0 ? trace.path : null,
        terminalPondId: trace.terminalPondId,
        pendingReason: trace.pendingReason,
        routeLocked: false,
      };
      if (schedule.pendingReason !== null && fields.pendingReason === null) cleared += 1;
      unlocked.push({
        schedule,
        fields,
        depth: fields.pendingReason === null ? Math.max(0, (fields.routePath?.length ?? 1) - 1) : 999,
      });
    }
    unlocked.sort(
      (a, b) =>
        a.depth - b.depth ||
        a.schedule.planDate.localeCompare(b.schedule.planDate, 'zh-Hans-CN') ||
        a.schedule.orderIndex - b.schedule.orderIndex ||
        a.schedule.id.localeCompare(b.schedule.id),
    );
    const lockedPositions = new Set(schedules.filter((item) => item.routeLocked).map((item) => item.orderIndex));
    const freeSlots = schedules
      .map((item) => item.orderIndex)
      .sort((a, b) => a - b)
      .filter((slot) => !lockedPositions.has(slot));
    for (let index = 0; index < unlocked.length; index += 1) {
      const { schedule, fields } = unlocked[index];
      await db.schedules.update(schedule.id, {
        ...fields,
        orderIndex: freeSlots[index] ?? schedules.length + index + 1,
        updatedAt: stamp,
      });
    }
    return cleared;
  });
}

/**
 * 事务内：未开始计划按当前拓扑重算路线（池删除后调用）。
 * 已锁定批次只重新核对路线字段，次序保持固定；未开始计划按
 * 「深度 → 日期 → 旧次序」重排，锁定项的相对位置原样保留。
 */
async function recalcUnlockedRoutesInTx(): Promise<void> {
  const [versions, gates, schedules, ponds] = await Promise.all([
    db.topologyVersions.toArray(),
    db.gates.toArray(),
    db.schedules.toArray(),
    db.ponds.toArray(),
  ]);
  if (versions.length === 0) return;
  const activeId = versions.reduce((max, item) => Math.max(max, item.id), INITIAL_TOPOLOGY_ID);
  const stamp = nowIso();

  // 锁定批次：只刷新路线快照字段，orderIndex 不动
  for (const schedule of schedules.filter((item) => item.routeLocked)) {
    const trace = traceRoute(schedule.pondId, gatesOfVersion(gates, schedule.routeVersionId || activeId), ponds);
    await db.schedules.update(schedule.id, {
      routePath: trace.path.length > 0 ? trace.path : schedule.routePath,
      terminalPondId: trace.terminalPondId,
      updatedAt: stamp,
    });
  }

  // 未开始计划：更新路线 / 待确认原因，再在不移动锁定项的前提下按新顺序填回剩余槽位
  const recomputed = schedules
    .filter((item) => !item.routeLocked)
    .map((schedule) => {
      const fields = resolveRouteFields(schedule.pondId, schedule.state, activeId, gates, ponds);
      const depth = fields.pendingReason === null ? Math.max(0, (fields.routePath?.length ?? 1) - 1) : 999;
      return { schedule, fields, depth };
    });
  recomputed.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.schedule.planDate.localeCompare(b.schedule.planDate, 'zh-Hans-CN') ||
      a.schedule.orderIndex - b.schedule.orderIndex ||
      a.schedule.id.localeCompare(b.schedule.id),
  );
  const lockedPositions = new Set(schedules.filter((item) => item.routeLocked).map((item) => item.orderIndex));
  const freeSlots = schedules
    .map((item) => item.orderIndex)
    .sort((a, b) => a - b)
    .filter((slot) => !lockedPositions.has(slot));
  for (let index = 0; index < recomputed.length; index += 1) {
    const { schedule, fields } = recomputed[index];
    await db.schedules.update(schedule.id, {
      ...fields,
      orderIndex: freeSlots[index] ?? schedules.length + index + 1,
      updatedAt: stamp,
    });
  }
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

/**
 * 写入走水计划：按当前拓扑自动补齐路线版本与路线。
 * - 新建 / 编辑为走水中或已出卤：立即锁定原路线；
 * - 未开始计划：按生效拓扑计算终点，走不通则进入待确认区。
 */
export async function saveScheduleWithRoute(row: Schedule): Promise<void> {
  const [versions, gates, ponds] = await Promise.all([
    db.topologyVersions.toArray(),
    db.gates.toArray(),
    db.ponds.toArray(),
  ]);
  const activeId = versions.reduce((max, item) => Math.max(max, item.id), INITIAL_TOPOLOGY_ID);
  const locked = LOCKED_STATES.includes(row.state);
  let fields;
  if (locked) {
    // 已锁定批次编辑时保留原路线；只有新建才按当前拓扑拍快照
    const hadRoute = row.routePath !== null && row.routePath.length > 0;
    fields = hadRoute
      ? {
          routeVersionId: row.routeVersionId || activeId,
          routePath: row.routePath,
          terminalPondId: row.terminalPondId,
          pendingReason: null,
          routeLocked: true,
        }
      : resolveRouteFields(row.pondId, row.state, activeId, gates, ponds);
  } else {
    fields = resolveRouteFields(row.pondId, row.state, activeId, gates, ponds);
  }
  const next: Schedule = {
    ...row,
    ...fields,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.schedules.put(next);
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, db.gates, db.topologyVersions, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    // 开始走水前锁定当时拓扑路线：未开始计划此前跟随生效拓扑，
    // 推进到「走水中」这一刻把路线快照固化，之后换线不再影响它。
    const [versions, gates, ponds] = await Promise.all([
      db.topologyVersions.toArray(),
      db.gates.toArray(),
      db.ponds.toArray(),
    ]);
    const activeId = versions.reduce((max, item) => Math.max(max, item.id), INITIAL_TOPOLOGY_ID);
    if (schedule.routePath === null || schedule.routePath.length === 0 || schedule.routeVersionId === 0) {
      const fields = resolveRouteFields(schedule.pondId, '走水中', activeId, gates, ponds);
      await db.schedules.update(scheduleId, {
        routeVersionId: fields.routeVersionId,
        routePath: fields.routePath,
        terminalPondId: fields.terminalPondId,
        routeLocked: true,
      });
    } else {
      await db.schedules.update(scheduleId, { routeLocked: true, pendingReason: null });
    }
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/**
 * 推进走水状态。推进到「走水中」时锁定路线，推进到「已出卤」时回写池阶段。
 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.transaction('rw', db.schedules, db.gates, db.ponds, db.topologyVersions, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    const changes: Partial<Schedule> = { state: next, updatedAt: nowIso() };
    if (next === '走水中' && !schedule.routeLocked) {
      const [versions, gates, ponds] = await Promise.all([
        db.topologyVersions.toArray(),
        db.gates.toArray(),
        db.ponds.toArray(),
      ]);
      const activeId = versions.reduce((max, item) => Math.max(max, item.id), INITIAL_TOPOLOGY_ID);
      const fields = resolveRouteFields(schedule.pondId, '走水中', activeId, gates, ponds);
      Object.assign(changes, {
        routeVersionId: fields.routeVersionId,
        routePath: fields.routePath,
        terminalPondId: fields.terminalPondId,
        pendingReason: null,
        routeLocked: true,
      });
    }
    await db.schedules.update(scheduleId, changes);
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number
  exportedAt: string
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  assays: Assay[]
  schedules: Schedule[]
  topologyVersions: TopologyVersion[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, topologyVersions] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.topologyVersions.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    topologyVersions,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.topologyVersions, db.switchDrafts],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.topologyVersions.clear(),
        // 换线草稿只在本机生效，导入存档不恢复未提交草稿
        db.switchDrafts.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(
        snapshot.gates.map((row) => ({
          ...row,
          topologyVersionId: row.topologyVersionId ?? INITIAL_TOPOLOGY_ID,
          revision: ROW_REVISION,
        })),
      );
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      const stampedSchedules = snapshot.schedules.map((row) => ({
        ...row,
        routeVersionId: row.routeVersionId ?? INITIAL_TOPOLOGY_ID,
        routePath: row.routePath ?? null,
        terminalPondId: row.terminalPondId ?? null,
        pendingReason: row.pendingReason ?? null,
        routeLocked: row.routeLocked ?? LOCKED_STATES.includes(row.state),
        revision: ROW_REVISION,
      }));
      await db.schedules.bulkPut(stampedSchedules);
      if (Array.isArray(snapshot.topologyVersions) && snapshot.topologyVersions.length > 0) {
        await db.topologyVersions.bulkPut(snapshot.topologyVersions.map((row) => ({ ...row, revision: ROW_REVISION })));
      } else {
        // 兼容 v1/v2 旧存档：建立初始版本并为闸门 / 计划补路线
        const version = await ensureInitialTopology();
        await db.gates.toCollection().modify((row: Gate) => {
          if (typeof row.topologyVersionId !== 'number') row.topologyVersionId = version.id;
        });
        const [ponds, gates, schedules] = await Promise.all([
          db.ponds.toArray(),
          db.gates.toArray(),
          db.schedules.toArray(),
        ]);
        for (const schedule of schedules) {
          const fields = resolveRouteFields(
            schedule.pondId,
            schedule.state,
            version.id,
            gatesOfVersion(gates, version.id),
            ponds,
          );
          await db.schedules.update(schedule.id, fields);
        }
      }
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.topologyVersions, db.switchDrafts],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.topologyVersions.clear(),
        db.switchDrafts.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, topologyVersions] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.topologyVersions.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, topologyVersions };
}
