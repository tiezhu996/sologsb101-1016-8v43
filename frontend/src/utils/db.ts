/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：闸门按路线版本归档、走水计划挂路线（锁定 / 待确认），新增 routeVersions、lineChangeDrafts 两表
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { RouteVersion } from '../types/routeVersion';
import { INITIAL_ROUTE_VERSION_CODE, INITIAL_ROUTE_VERSION_ID } from '../types/routeVersion';
import type { LineChangeDraft } from '../types/lineChange';
import { lineChangeDraftId } from '../types/lineChange';
import { analyzeLineChange, resequenceSchedules, traceRoute, type GateLike } from './topology';
import { estimateEvapMm } from './brine';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  routeVersions!: Table<RouteVersion, string>;
  lineChangeDrafts!: Table<LineChangeDraft, string>;

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
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：闸门路线版本化 + 走水计划挂路线 + 换线草稿 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, routeVersionId, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, routeVersionId, routeLocked, routePending',
        routeVersions: 'id, code, isActive, createdAt, committedAt',
        lineChangeDrafts: 'id, seriesName, baseVersionId, updatedAt',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();
        const ponds: Pond[] = await tx.table('ponds').toArray();
        const gates: Gate[] = await tx.table('gates').toArray();
        // 既有闸门全部归入初始路线版本 V1
        await tx.table('routeVersions').add({
          id: INITIAL_ROUTE_VERSION_ID,
          code: INITIAL_ROUTE_VERSION_CODE,
          isActive: true,
          operator: '',
          note: '既有串级自动归入初始路线版本',
          createdAt: stamp,
          committedAt: stamp,
          revision: ROW_REVISION,
        });
        await tx.table('gates').toCollection().modify((row: Record<string, unknown>) => {
          row.routeVersionId = INITIAL_ROUTE_VERSION_ID;
        });
        // 既有走水计划按 V1 拓扑补挂路线：已走水 / 已出卤锁定，断链 / 停用进待确认
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          const trace = traceRoute(typeof row.pondId === 'string' ? row.pondId : '', gates as GateLike[], ponds);
          const started = row.state === '走水中' || row.state === '已出卤';
          row.routeVersionId = INITIAL_ROUTE_VERSION_ID;
          row.routePath = trace.path;
          row.routeEndPondId = trace.endPondId;
          row.routeLocked = started;
          row.routePending = !trace.ok;
          row.routeIssue = trace.issue;
          row.routeConfirmed = trace.ok;
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
      // 兼容异常库：有闸门但缺路线版本时补建 V1 并重挂计划路线
      if ((await db.routeVersions.count()) === 0) {
        await bootstrapInitialRouteVersion();
      }
    })();
  }
  return initPromise;
}

/** 补建初始路线版本（v2 存档导入异常库等场景），并把全部闸门 / 计划归挂 V1 */
export async function bootstrapInitialRouteVersion(): Promise<void> {
  await db.transaction('rw', db.routeVersions, db.gates, db.schedules, db.ponds, async () => {
    const stamp = nowIso();
    const existing = await db.routeVersions.toCollection().last();
    if (existing !== undefined) return;
    const [ponds, gates] = await Promise.all([db.ponds.toArray(), db.gates.toArray()]);
    await db.routeVersions.put({
      id: INITIAL_ROUTE_VERSION_ID,
      code: INITIAL_ROUTE_VERSION_CODE,
      isActive: true,
      operator: '',
      note: '既有串级自动归入初始路线版本',
      createdAt: stamp,
      committedAt: stamp,
      revision: ROW_REVISION,
    });
    await Promise.all(
      gates.map((gate) => db.gates.update(gate.id, { routeVersionId: INITIAL_ROUTE_VERSION_ID })),
    );
    const schedules = await db.schedules.toArray();
    for (const row of schedules) {
      const trace = traceRoute(row.pondId, gates, ponds);
      await db.schedules.update(row.id, {
        routeVersionId: INITIAL_ROUTE_VERSION_ID,
        routePath: trace.path,
        routeEndPondId: trace.endPondId,
        routeLocked: row.routeLocked || row.state === '走水中' || row.state === '已出卤',
        routePending: !trace.ok,
        routeIssue: trace.issue,
        routeConfirmed: trace.ok,
      });
    }
  });
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
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.ponds.delete(id);
  });
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

/* ------------------------------ 路线版本 ------------------------------ */

export async function listRouteVersions(): Promise<RouteVersion[]> {
  const rows = await db.routeVersions.toArray();
  return rows.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
}

/** 取在用路线版本；空库兜底返回 null（调用方应先完成初始化 / 播种） */
export async function getActiveRouteVersion(): Promise<RouteVersion | null> {
  const all = await db.routeVersions.toArray();
  return all.find((version) => version.isActive) ?? all[0] ?? null;
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

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 按在用路线版本给计划重挂路线字段（新建 / 改池 / 推进状态时调用）。
 * 已锁定（走水中 / 已出卤）的计划不会被改挂版本；待确认一经人工确认不再自动回退。
 */
export async function stampScheduleRoute(row: Schedule): Promise<Schedule> {
  const [active, ponds, gatesAll] = await Promise.all([getActiveRouteVersion(), db.ponds.toArray(), db.gates.toArray()]);
  const versionId = active?.id ?? INITIAL_ROUTE_VERSION_ID;
  const started = row.state === '走水中' || row.state === '已出卤';
  const locked = row.routeLocked || started;
  if (locked) {
    return { ...row, routeLocked: true };
  }
  const gates = gatesAll.filter((gate) => gate.routeVersionId === versionId);
  const trace = traceRoute(row.pondId, gates, ponds);
  return {
    ...row,
    routeVersionId: versionId,
    routePath: trace.path,
    routeEndPondId: trace.endPondId,
    routeLocked: false,
    routePending: !trace.ok,
    routeIssue: trace.issue,
    routeConfirmed: trace.ok,
  };
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用）；锁定 / 待确认计划禁止拖拽，入口处已拦截 */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/** 调度员人工确认待确认路线：移出待确认区，保留原因供追溯 */
export async function confirmScheduleRoute(scheduleId: string): Promise<void> {
  await db.schedules.update(scheduleId, { routePending: false, routeConfirmed: true, updatedAt: nowIso() });
}

/**
 * 常规闸门增删改 / 调开度后，把未锁定（未开始走水）的计划按在用版本重挂路线。
 * 走水中 / 已出卤批次锁定原路线版本，不受日常闸门编辑影响；待确认一经人工确认也不回退。
 */
export async function resyncUnlockedSchedules(): Promise<void> {
  const [active, ponds, gatesAll, schedules] = await Promise.all([
    getActiveRouteVersion(),
    db.ponds.toArray(),
    db.gates.toArray(),
    db.schedules.toArray(),
  ]);
  if (active === null) return;
  const gates = gatesAll.filter((gate) => gate.routeVersionId === active.id);
  for (const row of schedules) {
    // 锁定批次不动；待确认项一经人工确认也保留，避免日常编辑把已确认项反复弹回待确认区
    if (row.routeLocked || row.routePending) continue;
    const trace = traceRoute(row.pondId, gates, ponds);
    await db.schedules.update(row.id, {
      routeVersionId: active.id,
      routePath: trace.path,
      routeEndPondId: trace.ok ? trace.endPondId : '',
      routePending: !trace.ok,
      routeIssue: trace.issue,
      routeConfirmed: trace.ok,
    });
  }
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 * 进入「已出卤」即锁定当前路线版本，后续换线不再改动该批次。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', routeLocked: true, updatedAt: nowIso() });
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

/** 推进走水状态；进入「走水中」即锁定当前路线 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, {
    state: next,
    ...(next === '走水中' ? { routeLocked: true } : {}),
    updatedAt: nowIso(),
  });
}

/* ------------------------------ 临时换线草稿 ------------------------------ */

export async function listLineChangeDrafts(): Promise<LineChangeDraft[]> {
  return db.lineChangeDrafts.toArray();
}

export async function getLineChangeDraft(seriesName: string): Promise<LineChangeDraft | undefined> {
  return db.lineChangeDrafts.get(lineChangeDraftId(seriesName));
}

export async function putLineChangeDraft(draft: LineChangeDraft): Promise<void> {
  await db.lineChangeDrafts.put({ ...draft, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function deleteLineChangeDraft(seriesName: string): Promise<void> {
  await db.lineChangeDrafts.delete(lineChangeDraftId(seriesName));
}

/** 换线提交结果：新版本与三类计划的数量（供页面提示） */
export interface LineChangeCommitResult {
  version: RouteVersion
  lockedCount: number
  recomputeCount: number
  pendingCount: number
  unchangedCount: number
}

/**
 * 提交临时换线（单事务，失败整体回滚）：
 * 1. 校验草稿基线仍是在用版本（防止与别处的提交错档）
 * 2. 旧在用版本归档，生成新路线版本；旧版本闸门整组保留
 * 3. 池系内闸门按草稿重写（删除 / 新增 / 改向 / 调开度），池系外闸门克隆进新版本
 * 4. 已开始 / 已出卤批次锁定原路线版本；未开始计划按新拓扑重算终点，
 *    经停用池 / 找不到连续下游的进待确认区；受影响计划按串级深度重排次序
 * 5. 删除草稿。任一步失败，事务回滚：原拓扑恢复，草稿与锁定 / 待确认项原样保留
 */
export async function commitLineChange(
  draft: LineChangeDraft,
  meta: { operator: string; note: string },
): Promise<LineChangeCommitResult> {
  return db.transaction(
    'rw',
    [db.routeVersions, db.gates, db.schedules, db.lineChangeDrafts, db.ponds],
    async () => {
      const [active, ponds, oldGatesAll, schedulesAll] = await Promise.all([
        getActiveRouteVersion(),
        db.ponds.toArray(),
        db.gates.toArray(),
        db.schedules.toArray(),
      ]);
      if (active === null) throw new Error('路线版本缺失，请刷新页面后重试');
      if (active.id !== draft.baseVersionId) {
        throw new Error('在用路线版本已变化（该草稿基线已归档或被其他换线提交），请放弃后按当前拓扑重建草稿');
      }
      const stamp = nowIso();
      const oldVersionGates = oldGatesAll.filter((gate) => gate.routeVersionId === active.id);

      const analysis = analyzeLineChange({
        seriesName: draft.seriesName,
        draftGates: draft.gates,
        oldGates: oldVersionGates,
        ponds,
        schedules: schedulesAll,
      });
      if (analysis.errors.length > 0) {
        throw new Error(`草稿闸门校验未通过：${analysis.errors[0]}`);
      }

      // 新版本号：V 后取既有最大序号 +1
      const versions = await db.routeVersions.toArray();
      const maxCode = versions.reduce((max, version) => {
        const num = Number(version.code.replace(/^V/i, ''));
        return Number.isFinite(num) ? Math.max(max, num) : max;
      }, 0);
      const newVersion: RouteVersion = {
        id: uuid('route'),
        code: `V${maxCode + 1}`,
        isActive: true,
        operator: meta.operator.trim(),
        note: meta.note.trim(),
        createdAt: stamp,
        committedAt: stamp,
        revision: ROW_REVISION,
      };

      // 池系外闸门克隆进新版本；池系内闸门以草稿为准（全部换新 id，旧行随旧版本保留）
      const inScopeGateIds = new Set(
        oldVersionGates
          .filter((gate) => ponds.find((pond) => pond.id === gate.fromPondId)?.seriesName === draft.seriesName)
          .map((gate) => gate.id),
      );
      const clonedOutside: Gate[] = oldVersionGates
        .filter((gate) => !inScopeGateIds.has(gate.id))
        .map((gate) => ({
          ...gate,
          id: uuid('gate'),
          routeVersionId: newVersion.id,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        }));
      const draftGates: Gate[] = draft.gates
        .filter(
          (row) =>
            !row.removed &&
            row.fromPondId !== '' &&
            row.toPondId !== '' &&
            (inScopeGateIds.has(row.gateId) ||
              (row.gateId === '' && ponds.find((pond) => pond.id === row.fromPondId)?.seriesName === draft.seriesName)),
        )
        .map((row) => ({
          id: uuid('gate'),
          routeVersionId: newVersion.id,
          fromPondId: row.fromPondId,
          toPondId: row.toPondId,
          openingPct: row.openingPct,
          widthCm: row.widthCm,
          state: row.state,
          note: row.note,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        }));

      // 计划重挂：锁定区保留旧版本；重算 / 待确认区挂新版本；池系外未锁定计划沿克隆拓扑重挂
      const newGateLikes: GateLike[] = [...clonedOutside, ...draftGates];
      const affectedIds = new Set(analysis.recompute.map((view) => view.schedule.id));
      const updatedSchedules: Schedule[] = schedulesAll.map((schedule) => {
        const view = analysis.plans.find((item) => item.schedule.id === schedule.id);
        if (view !== undefined) {
          if (view.zone === 'locked') {
            return { ...schedule, routeLocked: true };
          }
          const trace = view.newTrace;
          return {
            ...schedule,
            routeVersionId: newVersion.id,
            routePath: trace.path,
            routeEndPondId: trace.ok ? trace.endPondId : '',
            routeLocked: false,
            routePending: !trace.ok,
            routeIssue: trace.issue,
            routeConfirmed: trace.ok,
          };
        }
        // 池系外：锁定批次保留原版本，其余沿新版本（克隆拓扑）重挂
        if (schedule.routeLocked) return schedule;
        const trace = traceRoute(schedule.pondId, newGateLikes, ponds);
        return {
          ...schedule,
          routeVersionId: newVersion.id,
          routePath: trace.path,
          routeEndPondId: trace.ok ? trace.endPondId : '',
          routePending: !trace.ok,
          routeIssue: trace.issue,
          routeConfirmed: trace.ok,
        };
      });

      // 受影响计划连续成块、块内按串级深度重排；其余计划保持相对次序
      const orderedIds = resequenceSchedules(updatedSchedules, affectedIds);
      const orderMap = new Map(orderedIds.map((id, index) => [id, index + 1]));
      const finalSchedules = updatedSchedules.map((schedule) => ({
        ...schedule,
        orderIndex: orderMap.get(schedule.id) ?? schedule.orderIndex,
      }));

      await db.routeVersions.update(active.id, { isActive: false });
      await db.routeVersions.put(newVersion);
      await db.gates.bulkPut([...clonedOutside, ...draftGates]);
      await db.schedules.bulkPut(finalSchedules);
      await db.lineChangeDrafts.delete(draft.id);

      return {
        version: newVersion,
        lockedCount: analysis.locked.length,
        recomputeCount: analysis.recompute.length,
        pendingCount: analysis.pending.length,
        unchangedCount: analysis.recompute.filter((view) => view.unchanged).length,
      };
    },
  );
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  assays: Assay[]
  schedules: Schedule[]
  /** v3 起新增；旧存档导入时缺省为空数组并自动补建 V1 */
  routeVersions: RouteVersion[]
  lineChangeDrafts: LineChangeDraft[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, routeVersions, lineChangeDrafts] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.routeVersions.toArray(),
    db.lineChangeDrafts.toArray(),
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
    routeVersions,
    lineChangeDrafts,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.routeVersions, db.lineChangeDrafts],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.routeVersions.clear(),
        db.lineChangeDrafts.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      if (snapshot.routeVersions.length > 0) {
        await db.routeVersions.bulkPut(snapshot.routeVersions.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      if (snapshot.lineChangeDrafts.length > 0) {
        await db.lineChangeDrafts.bulkPut(snapshot.lineChangeDrafts.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      // 旧版存档（v2 及以前）没有路线版本：补建 V1 并按拓扑给计划挂路线
      if (snapshot.routeVersions.length === 0 && snapshot.gates.length > 0) {
        const stamp = nowIso();
        const ponds = await db.ponds.toArray();
        const gates = await db.gates.toArray();
        await db.routeVersions.put({
          id: INITIAL_ROUTE_VERSION_ID,
          code: INITIAL_ROUTE_VERSION_CODE,
          isActive: true,
          operator: '',
          note: '旧版存档导入，既有串级归入初始路线版本',
          createdAt: stamp,
          committedAt: stamp,
          revision: ROW_REVISION,
        });
        const schedules = await db.schedules.toArray();
        for (const row of schedules) {
          const trace = traceRoute(row.pondId, gates, ponds);
          await db.schedules.update(row.id, {
            routeVersionId: INITIAL_ROUTE_VERSION_ID,
            routePath: trace.path,
            routeEndPondId: trace.ok ? trace.endPondId : '',
            routeLocked: row.state === '走水中' || row.state === '已出卤',
            routePending: !trace.ok,
            routeIssue: trace.issue,
            routeConfirmed: trace.ok,
          });
        }
        await db.gates.toCollection().modify((gate: Gate) => {
          gate.routeVersionId = INITIAL_ROUTE_VERSION_ID;
        });
      }
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.routeVersions, db.lineChangeDrafts],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.routeVersions.clear(),
        db.lineChangeDrafts.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, routeVersions, lineChangeDrafts] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.routeVersions.count(),
    db.lineChangeDrafts.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, routeVersions, lineChangeDrafts };
}
