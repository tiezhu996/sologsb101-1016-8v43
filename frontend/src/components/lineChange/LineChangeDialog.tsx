/**
 * <LineChangeDialog> 闸门临时换线向导
 * 流程：选择池系 → 草稿内改串级（删除 / 新增 / 改向 / 调开度，自动暂存）
 *      → 按池系实时预览受影响计划：已开始 / 已出卤锁定原路线；
 *        未开始计划按新拓扑重算终点与次序；经停用池 / 找不到连续下游的留待确认区
 *      → 提交：单事务生成新路线版本并重写闸门串级，失败整体回滚、草稿保留，可重开继续。
 */
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import AppDialog from '../common/AppDialog';
import StageTag from '../common/StageTag';
import { usePondStore } from '../../stores/pondStore';
import { GATE_STATE_OPTIONS, type GateState } from '../../types/gate';
import { lineChangeDraftId, type LineChangeDraft, type LineChangeGateDraft } from '../../types/lineChange';
import {
  commitLineChange,
  deleteLineChangeDraft,
  getLineChangeDraft,
  putLineChangeDraft,
} from '../../utils/db';
import { analyzeLineChange, routePathText, type LineChangeAnalysis, type LineChangePlanView } from '../../utils/topology';
import { stateFromOpening } from '../../utils/brine';
import { nowIso, uuid } from '../../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-2 py-1 text-[13px] outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER =
  'rounded-md border border-rose-300 bg-white px-3.5 py-1.5 text-sm text-rose-600 transition hover:bg-rose-50';

export interface LineChangeDialogProps {
  open: boolean;
  initialSeries: string;
  onClose: () => void;
  /** 提交成功后回调，供页面切到新版本并提示 */
  onCommitted?: (message: string) => void;
}

function draftRowFromGate(gateId: string, gate: {
  fromPondId: string;
  toPondId: string;
  openingPct: number;
  widthCm: number;
  state: GateState;
  note: string;
}): LineChangeGateDraft {
  return {
    clientId: uuid('draftrow'),
    gateId,
    fromPondId: gate.fromPondId,
    toPondId: gate.toPondId,
    openingPct: gate.openingPct,
    widthCm: gate.widthCm,
    state: gate.state,
    note: gate.note,
    removed: false,
  };
}

export default function LineChangeDialog(props: LineChangeDialogProps) {
  const store = usePondStore();

  const [series, setSeries] = createSignal(props.initialSeries);
  const [loadedKey, setLoadedKey] = createSignal<string | null>(null);
  const [gates, setGates] = createSignal<LineChangeGateDraft[]>([]);
  const [operator, setOperator] = createSignal('');
  const [note, setNote] = createSignal('');
  const [baseVersionId, setBaseVersionId] = createSignal('');
  const [createdAt, setCreatedAt] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const pondOf = (pondId: string) => store.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.stage}${pond.status === '在用' ? '' : ` · ${pond.status}`}`;
  };

  const activeVersion = createMemo(() => store.activeRouteVersion());

  /** 弹层打开 / 切换池系时载入该池系草稿（无则按当前在用版本闸门生成） */
  const syncDraft = async (seriesName: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const active = activeVersion();
      if (active === null) {
        setError('路线版本缺失，请先关闭后刷新页面。');
        return;
      }
      const existing = await getLineChangeDraft(seriesName);
      if (existing !== undefined) {
        setSeries(existing.seriesName);
        setBaseVersionId(existing.baseVersionId);
        setOperator(existing.operator);
        setNote(existing.note);
        setGates(existing.gates.map((row) => ({ ...row })));
        setCreatedAt(existing.createdAt);
        setLoadedKey(existing.id);
      } else {
        const rows = store.state.gates
          .filter(
            (gate) =>
              gate.routeVersionId === active.id &&
              pondOf(gate.fromPondId)?.seriesName === seriesName,
          )
          .map((gate) => draftRowFromGate(gate.id, gate));
        const draft: LineChangeDraft = {
          id: lineChangeDraftId(seriesName),
          seriesName,
          baseVersionId: active.id,
          operator: '',
          note: '',
          gates: rows,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          revision: 3,
        };
        await putLineChangeDraft(draft);
        setSeries(seriesName);
        setBaseVersionId(active.id);
        setOperator('');
        setNote('');
        setGates(rows.map((row) => ({ ...row })));
        setCreatedAt(draft.createdAt);
        setLoadedKey(draft.id);
      }
    } finally {
      setBusy(false);
    }
  };

  // open / initialSeries 变化触发载入；池系由弹层内下拉切换
  let lastOpen = false;
  createMemo(() => {
    if (props.open && !lastOpen) {
      lastOpen = true;
      void syncDraft(props.initialSeries);
    } else if (!props.open) {
      lastOpen = false;
    }
  });

  const switchSeries = async (seriesName: string): Promise<void> => {
    await syncDraft(seriesName);
  };

  const persist = async (nextGates?: LineChangeGateDraft[]): Promise<void> => {
    if (loadedKey() === null) return;
    const draft: LineChangeDraft = {
      id: loadedKey() as string,
      seriesName: series(),
      baseVersionId: baseVersionId(),
      operator: operator(),
      note: note(),
      gates: (nextGates ?? gates()).map((row) => ({ ...row })),
      createdAt: createdAt() || nowIso(),
      updatedAt: nowIso(),
      revision: 3,
    };
    await putLineChangeDraft(draft);
  };

  const updateRow = (clientId: string, patch: Partial<LineChangeGateDraft>): void => {
    const next = gates().map((row) => (row.clientId === clientId ? { ...row, ...patch } : row));
    setGates(next);
    void persist(next);
  };

  const addRow = (): void => {
    const firstPond = store.pondsOfSeries(series())[0] ?? store.state.ponds[0];
    const nextPond = store.pondsOfSeries(series())[1] ?? store.state.ponds[1];
    const row: LineChangeGateDraft = {
      clientId: uuid('draftrow'),
      gateId: '',
      fromPondId: firstPond?.id ?? '',
      toPondId: nextPond?.id ?? '',
      openingPct: 50,
      widthCm: 120,
      state: '半开',
      note: '',
      removed: false,
    };
    const next = [...gates(), row];
    setGates(next);
    void persist(next);
  };

  const toggleRemoved = (clientId: string): void => {
    const next = gates().map((row) =>
      row.clientId === clientId ? { ...row, removed: !row.removed } : row,
    );
    setGates(next);
    void persist(next);
  };

  /** 实时影响分析：草稿闸门 vs 当前在用版本闸门 */
  const analysis = createMemo<LineChangeAnalysis | null>(() => {
    if (!props.open || loadedKey() === null || activeVersion() === null) return null;
    if (baseVersionId() !== activeVersion()?.id) return null;
    const oldGates = store.state.gates.filter((gate) => gate.routeVersionId === baseVersionId());
    return analyzeLineChange({
      seriesName: series(),
      draftGates: gates(),
      oldGates,
      ponds: store.state.ponds,
      schedules: store.state.schedules,
    });
  });

  const stale = createMemo(() => loadedKey() !== null && baseVersionId() !== activeVersion()?.id);

  const handleSubmit = async (): Promise<void> => {
    const result = analysis();
    if (result === null) return;
    if (result.errors.length > 0) {
      setError(`草稿闸门有 ${result.errors.length} 处错误，请先修正：${result.errors[0]}`);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // 提交前把表单内的调度员 / 说明落盘，保证与事务写入一致
      await persist();
      const draft = await getLineChangeDraft(series());
      if (draft === undefined) {
        setError('草稿不存在，可能已被提交，请关闭后重新打开。');
        return;
      }
      const commit = await commitLineChange(draft, { operator: operator(), note: note() });
      props.onCommitted?.(
        `换线已提交：${store.routeVersionCode(baseVersionId())} → ${commit.version.code}；` +
          `锁定原路线 ${commit.lockedCount} 条，重算 ${commit.recomputeCount} 条（其中路线不变 ${commit.unchangedCount} 条），待确认 ${commit.pendingCount} 条。`,
      );
      props.onClose();
    } catch (err) {
      // 事务失败已整体回滚：原拓扑恢复，草稿与锁定 / 待确认项原样保留，重开可继续
      setError(err instanceof Error ? err.message : '换线提交失败，已恢复原拓扑，草稿保留可继续修改。');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    await deleteLineChangeDraft(series());
    props.onClose();
  };

  const renderPlan = (view: LineChangePlanView): JSX.Element => {
    const row = view.schedule;
    const pond = pondOf(row.pondId);
    const isLocked = view.zone === 'locked';
    const isPending = view.zone === 'pending';
    return (
      <div
        class={`rounded-lg border px-3 py-2 text-[13px] ${
          isLocked
            ? 'border-slate-300 bg-slate-50'
            : isPending
              ? 'border-amber-300 bg-amber-50'
              : 'border-sky-200 bg-sky-50/60'
        }`}
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-slate-800">{pond === null ? '（池已删除）' : pond.code}</span>
          <StageTag stage={pond?.stage ?? null} size="sm" />
          <span class="text-xs text-slate-500">
            {row.planDate} · {row.operator === '' ? '调度员未填' : row.operator} · {row.state}
          </span>
          <span
            class={`rounded border px-1.5 py-px text-[11px] ${
              isLocked
                ? 'border-slate-300 bg-white text-slate-600'
                : isPending
                  ? 'border-amber-400 bg-white text-amber-700'
                  : 'border-sky-300 bg-white text-sky-700'
            }`}
            title="该计划当前挂用的路线版本"
          >
            路线 {store.routeVersionCode(row.routeVersionId)}
          </span>
          <Show when={isLocked}>
            <span class="rounded border border-slate-400 bg-white px-1.5 py-px text-[11px] text-slate-700">🔒 已锁定原路线</span>
          </Show>
        </div>
        <div class="mt-1.5 grid gap-1 text-xs text-slate-600">
          <p>
            原路线（{store.routeVersionCode(row.routeVersionId)}）：
            <span class={row.routeIssue !== '' && isLocked ? 'text-amber-700' : ''}>
              {routePathText(view.oldTrace.path, store.state.ponds) || '—'}
              {view.oldTrace.issue !== '' ? `（${view.oldTrace.issue}）` : ''}
            </span>
          </p>
          <Show when={!isLocked}>
            <p>
              新路线：
              <span class={isPending ? 'font-medium text-amber-800' : 'text-sky-800'}>
                {routePathText(view.newTrace.path, store.state.ponds) || '—'}
                {isPending
                  ? `（${view.newTrace.issue} → 留在待确认区）`
                  : ` → 终点 ${pondLabel(view.newTrace.endPondId)}`}
              </span>
              <Show when={!isPending && view.unchanged}>
                <span class="ml-1 text-slate-400">（走向不变，仅挂新版本）</span>
              </Show>
            </p>
            <Show when={!isPending}>
              <p class="text-slate-500">
                次序：原第 {row.orderIndex} 位 → 重排为池系受影响块内第 {view.newOrderIndex} 位（按串级深度，浅池先走水）
              </p>
            </Show>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <AppDialog
      open={props.open}
      title="闸门临时换线"
      width="max-w-5xl"
      onClose={props.onClose}
      footer={
        <>
          <button class={BTN_DANGER} onClick={() => void handleDiscard()} disabled={submitting() || busy()}>
            放弃草稿
          </button>
          <button class={BTN_GHOST} onClick={props.onClose} disabled={submitting()}>
            暂存并关闭（重开可继续）
          </button>
          <button class={BTN_PRIMARY} onClick={() => void handleSubmit()} disabled={submitting() || busy() || stale()}>
            {submitting() ? '提交中…' : '提交换线'}
          </button>
        </>
      }
    >
      <div class="space-y-4">
        {/* 基本信息 */}
        <div class="grid gap-3 sm:grid-cols-3">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>换线池系</span>
            <select class={INPUT} value={series()} onChange={(event) => void switchSeries(event.currentTarget.value)}>
              <For each={store.seriesOptions()}>
                {(item) => (
                  <option value={item}>
                    {item}
                    {store.lineChangeDraftOf(item) !== undefined && store.lineChangeDraftOf(item)?.id !== loadedKey()
                      ? '（有未提交草稿）'
                      : ''}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input
              class={INPUT}
              value={operator()}
              onInput={(event) => {
                setOperator(event.currentTarget.value);
                void persist();
              }}
              placeholder="提交人姓名"
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>换线说明</span>
            <input
              class={INPUT}
              value={note()}
              onInput={(event) => {
                setNote(event.currentTarget.value);
                void persist();
              }}
              placeholder="如：临时改走备用通道绕开清池塘"
            />
          </label>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded border border-brine-200 bg-brine-50 px-2 py-0.5 text-brine-700">
            基线版本：{store.routeVersionCode(baseVersionId())}
          </span>
          <span class="text-slate-400">→ 提交后生成新版本并归档当前版本；旧版本闸门整组保留，供锁定批次追溯</span>
          <Show when={store.lineChangeDraftOf(series()) !== undefined}>
            <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-700">
              草稿暂存中（{createdAt().slice(0, 10)} 起）
            </span>
          </Show>
        </div>

        <Show when={stale()}>
          <div class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
            该草稿基线 {store.routeVersionCode(baseVersionId())} 已不是在用版本（在用 {store.routeVersionCode(activeVersion()?.id ?? '')}），
            不能直接提交。请放弃本草稿，按当前拓扑重新发起换线。
          </div>
        </Show>
        <Show when={error() !== ''}>
          <div class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
            {error()}
          </div>
        </Show>

        {/* 草稿闸门编辑 */}
        <section class="rounded-lg border border-slate-200">
          <header class="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h4 class="text-sm font-semibold text-slate-800">① 新拓扑草稿（池系 {series()} 的闸门串级）</h4>
            <button type="button" class={BTN_GHOST} onClick={addRow}>
              + 新增闸门
            </button>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[860px] border-collapse text-[13px]">
              <thead>
                <tr class="bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-2 py-1.5">上游池</th>
                  <th class="px-1 py-1.5"></th>
                  <th class="px-2 py-1.5">下游池</th>
                  <th class="px-2 py-1.5 w-24">开度%</th>
                  <th class="px-2 py-1.5 w-28">口宽cm</th>
                  <th class="px-2 py-1.5">状态</th>
                  <th class="px-2 py-1.5">备注</th>
                  <th class="px-2 py-1.5 w-20">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={gates()}>
                  {(row) => (
                    <tr class={`border-t border-slate-100 ${row.removed ? 'opacity-40' : ''}`}>
                      <td class="px-2 py-1.5">
                        <select
                          class={INPUT}
                          value={row.fromPondId}
                          disabled={row.removed}
                          onChange={(event) => updateRow(row.clientId, { fromPondId: event.currentTarget.value })}
                        >
                          <For each={store.state.ponds}>
                            {(pond) => (
                              <option value={pond.id}>
                                {pond.code} · {pond.seriesName}
                              </option>
                            )}
                          </For>
                        </select>
                      </td>
                      <td class="px-1 text-brine-600">→</td>
                      <td class="px-2 py-1.5">
                        <select
                          class={INPUT}
                          value={row.toPondId}
                          disabled={row.removed}
                          onChange={(event) => updateRow(row.clientId, { toPondId: event.currentTarget.value })}
                        >
                          <For each={store.state.ponds}>
                            {(pond) => (
                              <option value={pond.id}>
                                {pond.code} · {pond.seriesName}
                              </option>
                            )}
                          </For>
                        </select>
                      </td>
                      <td class="px-2 py-1.5">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          class={INPUT}
                          value={row.openingPct}
                          disabled={row.removed}
                          onInput={(event) => {
                            const openingPct = Number(event.currentTarget.value);
                            updateRow(row.clientId, { openingPct, state: stateFromOpening(openingPct) });
                          }}
                        />
                      </td>
                      <td class="px-2 py-1.5">
                        <input
                          type="number"
                          min="10"
                          max="600"
                          class={INPUT}
                          value={row.widthCm}
                          disabled={row.removed}
                          onInput={(event) => updateRow(row.clientId, { widthCm: Number(event.currentTarget.value) })}
                        />
                      </td>
                      <td class="px-2 py-1.5">
                        <select
                          class={INPUT}
                          value={row.state}
                          disabled={row.removed}
                          onChange={(event) => updateRow(row.clientId, { state: event.currentTarget.value as GateState })}
                        >
                          <For each={GATE_STATE_OPTIONS}>{(item) => <option value={item}>{item}</option>}</For>
                        </select>
                      </td>
                      <td class="px-2 py-1.5">
                        <input
                          class={INPUT}
                          value={row.note}
                          disabled={row.removed}
                          onInput={(event) => updateRow(row.clientId, { note: event.currentTarget.value })}
                        />
                      </td>
                      <td class="px-2 py-1.5">
                        <button
                          type="button"
                          class={`text-xs ${row.removed ? 'text-brine-700' : 'text-rose-600'} hover:underline`}
                          onClick={() => toggleRemoved(row.clientId)}
                        >
                          {row.removed ? (row.gateId === '' ? '移除行' : '恢复') : '删除'}
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <p class="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400">
            关闭的闸门（状态关闭或开度 0）不参与连续下游推演；多个开启下游闸时按开度最大者继续。每行修改都会自动暂存。
          </p>
        </section>

        {/* 受影响计划 */}
        <section class="space-y-2">
          <h4 class="text-sm font-semibold text-slate-800">② 受影响走水计划（按池系 {series()} 列出）</h4>
          <Show when={analysis()?.errors.length}>
            <div class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
              <For each={analysis()?.errors ?? []}>{(item) => <p>· {item}</p>}</For>
            </div>
          </Show>

          <div class="grid gap-2 lg:grid-cols-3">
            <div class="rounded-lg border border-slate-200 p-2.5">
              <div class="mb-1.5 flex items-center justify-between">
                <h5 class="text-[13px] font-semibold text-slate-700">🔒 锁定原路线</h5>
                <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                  {analysis()?.locked.length ?? 0} 条
                </span>
              </div>
              <p class="mb-2 text-xs text-slate-400">已开始走水或已出卤的批次，版本与次序不变</p>
              <div class="space-y-2">
                <For each={analysis()?.locked ?? []}>{(view) => renderPlan(view)}</For>
                <Show when={(analysis()?.locked.length ?? 0) === 0}>
                  <p class="text-xs text-slate-400">本池系没有进行中的批次</p>
                </Show>
              </div>
            </div>

            <div class="rounded-lg border border-sky-200 p-2.5">
              <div class="mb-1.5 flex items-center justify-between">
                <h5 class="text-[13px] font-semibold text-sky-800">↻ 按新拓扑重算</h5>
                <span class="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] text-sky-700">
                  {analysis()?.recompute.length ?? 0} 条
                </span>
              </div>
              <p class="mb-2 text-xs text-sky-700/70">未开始（待排 / 已排）计划重算终点，按串级深度重排次序</p>
              <div class="space-y-2">
                <For each={analysis()?.recompute ?? []}>{(view) => renderPlan(view)}</For>
                <Show when={(analysis()?.recompute.length ?? 0) === 0}>
                  <p class="text-xs text-slate-400">没有可重算的未开始计划</p>
                </Show>
              </div>
            </div>

            <div class="rounded-lg border border-amber-300 p-2.5">
              <div class="mb-1.5 flex items-center justify-between">
                <h5 class="text-[13px] font-semibold text-amber-800">⚠ 待确认区</h5>
                <span class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">
                  {analysis()?.pending.length ?? 0} 条
                </span>
              </div>
              <p class="mb-2 text-xs text-amber-700/80">经过停用池或找不到连续下游，提交后仍留在此区，由调度员到走水编排页人工确认</p>
              <div class="space-y-2">
                <For each={analysis()?.pending ?? []}>{(view) => renderPlan(view)}</For>
                <Show when={(analysis()?.pending.length ?? 0) === 0}>
                  <p class="text-xs text-slate-400">没有需要待确认的计划</p>
                </Show>
              </div>
            </div>
          </div>
        </section>
      </div>
    </AppDialog>
  );
}
