/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  recheckPendingSchedules,
  removeSchedule,
  reorderSchedules,
  ROW_REVISION,
  saveScheduleWithRoute,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      // 路线字段由 db 层按当前生效拓扑补齐（走水中 / 已出卤直接锁定）
      routeVersionId: 0,
      routePath: null,
      terminalPondId: null,
      pendingReason: null,
      routeLocked: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await saveScheduleWithRoute(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    await saveScheduleWithRoute({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
    });
    setState('lastMessage', '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];
    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState(
      'lastMessage',
      next === '已出卤'
        ? `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`
        : `状态已推进为「${next}」`,
    );
    return next;
  }

  /** 行是否可拖拽 / 可作为落点：已锁定批次与待确认项固定，不参与重排 */
  function isMovable(row: Schedule): boolean {
    return !row.routeLocked && row.pendingReason === null;
  }

  /**
   * 拖拽排序：把 fromId 移动到 toId 之前。
   * 已锁定路线（走水中 / 已出卤）与待确认项的次序固定，
   * 因此只在可移动行形成的序列里移动，固定行的位置原样保留。
   */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const from = list.find((row) => row.id === fromId);
    const to = list.find((row) => row.id === toId);
    if (from === undefined || to === undefined || !isMovable(from) || !isMovable(to)) return;
    const without = list.filter((row) => row.id !== fromId);
    const targetIndex = without.findIndex((row) => row.id === toId);
    without.splice(targetIndex, 0, from);
    await reorderSchedules(without.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${from.planDate} 移动到目标计划之前`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const moving = list.find((row) => row.id === id);
    if (moving === undefined || !isMovable(moving)) return;
    // 在可移动行组成的子序列中换位，固定行（已锁定 / 待确认）保持原位
    const movable = list.filter(isMovable);
    const fromIndex = movable.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = movable.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(movable.length, targetIndex));
    movable.splice(index, 0, moved);
    // 按总列表的槽位回填：固定槽位保留原固定行，可移动槽位依次取新序列
    const fixed = list.filter((row) => !isMovable(row));
    const ordered: Schedule[] = [];
    let fixedPos = 0;
    let movablePos = 0;
    for (const row of list) {
      if (isMovable(row)) {
        ordered.push(movable[movablePos]);
        movablePos += 1;
      } else {
        ordered.push(fixed[fixedPos]);
        fixedPos += 1;
      }
    }
    await reorderSchedules(ordered.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 个可执行位置`);
  }

  /** 复查待确认计划：停用池恢复 / 闸门补齐后按当前拓扑重新计算 */
  async function recheckPending(): Promise<number> {
    const cleared = await recheckPendingSchedules();
    setState('lastMessage', cleared > 0 ? `复查完成：${cleared} 条计划已恢复连续下游` : '复查完成：仍没有可恢复的连续下游，计划继续留在待确认区');
    return cleared;
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    moveBefore,
    moveToIndex,
    isMovable,
    recheckPending,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
