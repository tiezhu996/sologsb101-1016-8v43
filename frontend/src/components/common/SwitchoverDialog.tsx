/**
 * <SwitchoverDialog> 临时换线操作对话框（/gates 页使用）
 *
 * 流程：
 * 1. 打开时从 IndexedDB 取未提交草稿（没有则克隆当前生效闸门为工作副本），
 *    任何编辑即时落草稿，关闭 / 刷新 / 重开页面都能继续；
 * 2. 提交前按池系列出受影响走水计划：已开始 / 已出卤锁定原路线，
 *    未开始按新拓扑重算终点与次序，走不通（停用池 / 无连续下游）进待确认；
 * 3. 提交走单事务：失败自动回滚原拓扑，草稿、锁定批次、待确认项全部保留。
 */
import { For, Show, createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from './AppDialog';
import type { Gate } from '../../types/gate';
import type { Schedule } from '../../types/schedule';
import type { Pond } from '../../types/pond';
import type { SwitchDraft, SwitchDraftGate, TopologyVersion } from '../../types/topology';
import type { SwitchPlan } from '../../utils/topology';
import {
  cloneGatesToDraft,
  planSwitchover,
  routeChainText,
  routeVersionLabel,
  validateCandidateGates,
} from '../../utils/topology';
import { clearSwitchDraft, commitSwitchover, getSwitchDraft, putSwitchDraft, ROW_REVISION, SWITCH_DRAFT_ID } from '../../utils/db';
import { stateFromOpening } from '../../utils/brine';
import { nowIso, uuid } from '../../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

export interface SwitchoverDialogProps {
  open: boolean;
  onClose: () => void;
  ponds: Pond[];
  gates: Gate[];
  schedules: Schedule[];
  activeTopology: TopologyVersion | null;
  onCommitted: (message: string) => void;
}

type LoadState = 'loading' | 'ready' | 'closed';

export default function SwitchoverDialog(props: SwitchoverDialogProps) {
  const [loadState, setLoadState] = createSignal<LoadState>('closed');
  const [draftGates, setDraftGates] = createStore<SwitchDraftGate[]>([]);
  const [meta, setMeta] = createStore<{ note: string; operator: string }>({ note: '', operator: '' });
  const [baseVersionId, setBaseVersionId] = createSignal<number>(0);
  const [resumedAt, setResumedAt] = createSignal<string>('');
  const [error, setError] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [discardOpen, setDiscardOpen] = createSignal(false);

  // 对话框每次打开都重新载入：有未提交草稿则恢复，否则克隆当前生效拓扑。
  // untracked 确保只响应 open 变化，拓扑数据随后台刷新时不会冲掉工作区编辑。
  createEffect(() => {
    if (props.open) {
      setLoadState('loading');
      void untrack(() => ensureLoaded());
    } else {
      setLoadState('closed');
      setError('');
    }
  });

  const pondOf = (pondId: string): Pond | undefined => props.ponds.find((pond) => pond.id === pondId);
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 打开对话框：优先恢复未提交草稿，否则克隆生效拓扑 */
  const ensureLoaded = async (): Promise<void> => {
    if (loadState() === 'ready') return;
    setError('');
    const saved = await getSwitchDraft();
    if (saved !== null) {
      setDraftGates(saved.gates.map((gate) => ({ ...gate })));
      setMeta({ note: saved.note, operator: saved.operator });
      setBaseVersionId(saved.baseVersionId);
      setResumedAt(saved.updatedAt);
    } else {
      const active = props.activeTopology;
      const gates = active === null ? [] : props.gates.filter((gate) => gate.topologyVersionId === active.id);
      setDraftGates(cloneGatesToDraft(gates));
      setMeta({ note: '', operator: '' });
      setBaseVersionId(active?.id ?? 0);
      setResumedAt('');
    }
    setLoadState('ready');
  };

  /** 任何工作区改动都立即落草稿，保证刷新 / 重开可以继续 */
  const persist = async (nextGates: SwitchDraftGate[], nextMeta: { note: string; operator: string }): Promise<void> => {
    const stamp = nowIso();
    const existing = await getSwitchDraft();
    const draft: SwitchDraft = {
      id: SWITCH_DRAFT_ID,
      gates: nextGates.map((gate) => ({ ...gate })),
      note: nextMeta.note,
      operator: nextMeta.operator,
      baseVersionId: baseVersionId(),
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putSwitchDraft(draft);
    if (resumedAt() === '') setResumedAt(stamp);
  };

  const liveGates = createMemo<SwitchDraftGate[]>(() => draftGates.filter((gate) => !gate.removed));

  /** 候选闸门转换成正式闸门（保留已有 id，新增闸门用 draft-gate- 前缀占位） */
  const candidateGates = createMemo<Gate[]>(() =>
    liveGates().map((gate) => ({
      id: gate.sourceGateId ?? gate.draftId,
      fromPondId: gate.fromPondId,
      toPondId: gate.toPondId,
      openingPct: gate.openingPct,
      widthCm: gate.widthCm,
      state: stateFromOpening(gate.openingPct),
      note: gate.note,
      topologyVersionId: baseVersionId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    })),
  );

  const issues = createMemo(() => validateCandidateGates(liveGates(), props.ponds));


  /** 提交后将生成的新版本号（纯展示，实际以事务内取值为准） */
  const newVersionId = createMemo<number>(() => {
    const versions = props.activeTopology === null ? [] : [props.activeTopology.id];
    return Math.max(baseVersionId(), ...versions, 0) + 1;
  });

  const plans = createMemo<SwitchPlan[]>(() =>
    planSwitchover({
      schedules: props.schedules,
      ponds: props.ponds,
      gates: props.gates,
      candidateGates: candidateGates(),
      newVersionId: newVersionId(),
    }),
  );

  const seriesGroups = createMemo<Array<{ series: string; items: SwitchPlan[] }>>(() => {
    const map = new Map<string, SwitchPlan[]>();
    for (const plan of plans()) {
      const list = map.get(plan.seriesName) ?? [];
      list.push(plan);
      map.set(plan.seriesName, list);
    }
    return Array.from(map.entries())
      .map(([series, items]) => ({
        series,
        items: items.sort((a, b) => a.newOrderIndex - b.newOrderIndex),
      }))
      .sort((a, b) => a.series.localeCompare(b.series, 'zh-Hans-CN'));
  });

  const counts = createMemo(() => ({
    locked: plans().filter((plan) => plan.action === '锁定原路线').length,
    recomputed: plans().filter((plan) => plan.action === '按新拓扑重算').length,
    pending: plans().filter((plan) => plan.action === '进入待确认区').length,
  }));

  /* ------------------------------ 工作区编辑 ------------------------------ */

  const updateGate = (draftId: string, patch: Partial<SwitchDraftGate>): void => {
    const next = draftGates.map((gate) =>
      gate.draftId === draftId
        ? {
            ...gate,
            ...patch,
            state:
              patch.openingPct === undefined ? gate.state : stateFromOpening(patch.openingPct),
          }
        : gate,
    );
    setDraftGates(next);
    void persist(next, { note: meta.note, operator: meta.operator });
  };

  const addGate = (): void => {
    const first = props.ponds[0]?.id ?? '';
    const second = props.ponds[1]?.id ?? '';
    const row: SwitchDraftGate = {
      draftId: `draft-gate-${uuid('tmp')}`,
      sourceGateId: null,
      fromPondId: first,
      toPondId: second,
      openingPct: 50,
      widthCm: 120,
      state: '半开',
      note: '',
      removed: false,
    };
    const next = [...draftGates, row];
    setDraftGates(next);
    void persist(next, { note: meta.note, operator: meta.operator });
  };

  const removeGate = (draftId: string): void => {
    const next = draftGates.map((gate) => (gate.draftId === draftId ? { ...gate, removed: true } : gate));
    setDraftGates(next);
    void persist(next, { note: meta.note, operator: meta.operator });
  };

  const restoreGate = (draftId: string): void => {
    const next = draftGates.map((gate) => (gate.draftId === draftId ? { ...gate, removed: false } : gate));
    setDraftGates(next);
    void persist(next, { note: meta.note, operator: meta.operator });
  };

  const removedCount = createMemo(() => draftGates.filter((gate) => gate.removed).length);

  const updateMeta = (patch: { note?: string; operator?: string }): void => {
    const next = { ...meta, ...patch };
    setMeta(next);
    void persist(draftGates.map((gate) => ({ ...gate })), next);
  };

  /* -------------------------------- 提交 -------------------------------- */

  const handleSubmit = async (): Promise<void> => {
    if (issues().length > 0) {
      setError(`候选拓扑存在 ${issues().length} 处问题，请先修正后再提交。`);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const version = await commitSwitchover({
        note: meta.note,
        operator: meta.operator,
        candidateGates: candidateGates(),
      });
      setLoadState('closed');
      setSubmitting(false);
      props.onCommitted(
        `换线已提交：${version.name} 生效；${counts().locked} 条批次锁定原路线，${counts().recomputed} 条按新拓扑重算，${counts().pending} 条进入待确认区。`,
      );
    } catch (err) {
      // 事务回滚：原拓扑、锁定批次、待确认项与草稿都保留，可直接继续编辑再提交
      setSubmitting(false);
      setError(`换线提交失败，已恢复原拓扑（${err instanceof Error ? err.message : '未知错误'}）。草稿与待确认项均已保留，可修改后重新提交。`);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    await clearSwitchDraft();
    setDiscardOpen(false);
    setLoadState('closed');
    props.onCommitted('已放弃本次换线草稿，闸门串级保持原拓扑。');
  };

  const ACTION_STYLE: Record<SwitchPlan['action'], string> = {
    锁定原路线: 'border-amber-300 bg-amber-50 text-amber-700',
    按新拓扑重算: 'border-sky-300 bg-sky-50 text-sky-700',
    进入待确认区: 'border-rose-300 bg-rose-50 text-rose-700',
  };

  return (
    <AppDialog
      open={props.open}
      title="临时换线：闸门串级调整与走水计划重排"
      width="max-w-5xl"
      onClose={() => {
        setLoadState('closed');
        props.onClose();
      }}
      footer={
        <>
          <button class={BTN_GHOST} onClick={() => setDiscardOpen(true)}>
            放弃草稿
          </button>
          <button
            class={BTN_GHOST}
            onClick={() => {
              setLoadState('closed');
              props.onClose();
            }}
          >
            关闭（草稿保留）
          </button>
          <button class={BTN_PRIMARY} disabled={submitting() || issues().length > 0} onClick={() => void handleSubmit()}>
            {submitting() ? '提交中…' : `提交换线（生成 ${routeVersionLabel(newVersionId())}）`}
          </button>
        </>
      }
    >
      <Show when={loadState() === 'loading'}>
        <p class="py-10 text-center text-sm text-slate-400">正在载入换线工作区…</p>
      </Show>

      <Show when={loadState() === 'ready'}>
        <div class="space-y-4">
          <Show when={resumedAt() !== ''}>
            <div class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              已恢复上次未提交的换线草稿（保存于 {resumedAt()}）。提交失败、关闭页面后重开都能继续；已锁定批次与待确认项不会丢失。
            </div>
          </Show>

          <Show when={error() !== ''}>
            <div class="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">
              {error()}
            </div>
          </Show>

          <div class="flex flex-wrap gap-2 text-xs">
            <span class="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-600">
              基准拓扑：{routeVersionLabel(baseVersionId())}
            </span>
            <span class="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-700">
              锁定原路线 {counts().locked} 条
            </span>
            <span class="rounded-full border border-sky-300 bg-sky-50 px-2.5 py-1 text-sky-700">
              按新拓扑重算 {counts().recomputed} 条
            </span>
            <span class="rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-rose-700">
              进入待确认区 {counts().pending} 条
            </span>
          </div>

          {/* 1. 候选拓扑编辑 */}
          <section class="rounded-lg border border-slate-200">
            <header class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
              <h4 class="text-[13px] font-semibold text-slate-800">
                新拓扑闸门工作区
                <span class="ml-2 text-xs font-normal text-slate-400">
                  {liveGates().length} 条生效{removedCount() > 0 ? `，${removedCount()} 条待删除` : ''}
                </span>
              </h4>
              <button type="button" class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 hover:bg-brine-100" onClick={addGate}>
                + 新增闸门
              </button>
            </header>
            <div class="overflow-x-auto">
              <table class="w-full min-w-[860px] border-collapse text-xs">
                <thead>
                  <tr class="bg-slate-50 text-left text-slate-500">
                    <th class="px-2.5 py-1.5">上游池</th>
                    <th class="px-2.5 py-1.5">下游池</th>
                    <th class="px-2.5 py-1.5 w-44">开度 %</th>
                    <th class="px-2.5 py-1.5 w-28">口宽 cm</th>
                    <th class="px-2.5 py-1.5">状态</th>
                    <th class="px-2.5 py-1.5">备注</th>
                    <th class="px-2.5 py-1.5">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={draftGates}>
                    {(gate) => (
                      <tr class={`border-t border-slate-100 ${gate.removed ? 'bg-slate-50 text-slate-400 line-through' : ''}`}>
                        <td class="px-2.5 py-1.5">
                          <select
                            class={INPUT}
                            disabled={gate.removed}
                            value={gate.fromPondId}
                            onChange={(event) => updateGate(gate.draftId, { fromPondId: event.currentTarget.value })}
                          >
                            <For each={props.ponds}>
                              {(pond) => <option value={pond.id}>{pond.code} · {pond.seriesName}</option>}
                            </For>
                          </select>
                        </td>
                        <td class="px-2.5 py-1.5">
                          <select
                            class={INPUT}
                            disabled={gate.removed}
                            value={gate.toPondId}
                            onChange={(event) => updateGate(gate.draftId, { toPondId: event.currentTarget.value })}
                          >
                            <For each={props.ponds}>
                              {(pond) => <option value={pond.id}>{pond.code} · {pond.seriesName}</option>}
                            </For>
                          </select>
                        </td>
                        <td class="px-2.5 py-1.5">
                          <div class="flex items-center gap-2">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              step="5"
                              value={gate.openingPct}
                              disabled={gate.removed}
                              class="h-1.5 flex-1 accent-brine-600"
                              onInput={(event) => updateGate(gate.draftId, { openingPct: Number(event.currentTarget.value) })}
                            />
                            <span class="w-9 tabular-nums">{gate.openingPct}</span>
                          </div>
                        </td>
                        <td class="px-2.5 py-1.5">
                          <input
                            type="number"
                            min="10"
                            max="600"
                            class={INPUT}
                            disabled={gate.removed}
                            value={gate.widthCm}
                            onInput={(event) => updateGate(gate.draftId, { widthCm: Number(event.currentTarget.value) })}
                          />
                        </td>
                        <td class="px-2.5 py-1.5">
                          <span
                            class={`rounded border px-1.5 py-0.5 ${
                              stateFromOpening(gate.openingPct) === '关闭'
                                ? 'border-slate-300 bg-slate-100 text-slate-500'
                                : stateFromOpening(gate.openingPct) === '全开'
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                                  : 'border-amber-300 bg-amber-50 text-amber-700'
                            }`}
                          >
                            {stateFromOpening(gate.openingPct)}
                          </span>
                        </td>
                        <td class="px-2.5 py-1.5">
                          <input
                            class={INPUT}
                            disabled={gate.removed}
                            value={gate.note}
                            placeholder="换线备注"
                            onInput={(event) => updateGate(gate.draftId, { note: event.currentTarget.value })}
                          />
                        </td>
                        <td class="px-2.5 py-1.5">
                          <Show
                            when={!gate.removed}
                            fallback={
                              <button class="text-xs text-brine-700 hover:underline" onClick={() => restoreGate(gate.draftId)}>
                                撤销删除
                              </button>
                            }
                          >
                            <button class="text-xs text-rose-600 hover:underline" onClick={() => removeGate(gate.draftId)}>
                              删除
                            </button>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={issues().length > 0}>
              <div class="space-y-1 border-t border-rose-100 bg-rose-50 px-3 py-2">
                <For each={issues()}>
                  {(issue) => (
                    <p class="text-xs text-rose-700">
                      · {pondLabel(draftGates.find((gate) => gate.draftId === issue.draftId)?.fromPondId ?? '')} →{' '}
                      {pondLabel(draftGates.find((gate) => gate.draftId === issue.draftId)?.toPondId ?? '')}：{issue.message}
                    </p>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-[13px] text-slate-600">
              <span>调度员</span>
              <input class={INPUT} value={meta.operator} placeholder="提交换线的调度员" onInput={(event) => updateMeta({ operator: event.currentTarget.value })} />
            </label>
            <label class="flex flex-col gap-1 text-[13px] text-slate-600">
              <span>换线原因</span>
              <input class={INPUT} value={meta.note} placeholder="如：盐田临时改走备用串级" onInput={(event) => updateMeta({ note: event.currentTarget.value })} />
            </label>
          </div>

          {/* 2. 受影响计划：按池系分组 */}
          <section class="rounded-lg border border-slate-200">
            <header class="border-b border-slate-100 px-3 py-2">
              <h4 class="text-[13px] font-semibold text-slate-800">受影响走水计划（提交前预览）</h4>
              <p class="mt-0.5 text-xs text-slate-400">
                已开始 / 已出卤批次锁定原路线不动；未开始计划按新拓扑重算终点和次序；经过停用池或找不到连续下游的留在待确认区。
              </p>
            </header>
            <div class="space-y-3 px-3 py-2.5">
              <For each={seriesGroups()}>
                {(group) => (
                  <div class="rounded-md border border-slate-100">
                    <div class="border-b border-slate-100 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
                      {group.series}
                      <span class="ml-2 font-normal text-slate-400">{group.items.length} 条计划</span>
                    </div>
                    <ul class="divide-y divide-slate-100">
                      <For each={group.items}>
                        {(plan) => (
                          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 text-xs">
                            <span class="w-8 text-center font-semibold tabular-nums text-slate-400" title="重排后次序">
                              {plan.newOrderIndex}
                            </span>
                            <span class="font-medium text-slate-800">{pondLabel(plan.pondId)}</span>
                            <span class="text-slate-500">{plan.planDate}</span>
                            <span class="text-slate-400">原状态 {plan.state}</span>
                            <span class={`rounded border px-1.5 py-0.5 ${ACTION_STYLE[plan.action]}`}>{plan.action}</span>
                            <span class="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-500">
                              {routeVersionLabel(plan.routeVersionId)}
                            </span>
                            <span class="flex-1 text-slate-600" classList={{ 'text-rose-600': plan.pendingReason !== null }}>
                              <Show when={plan.pendingReason === null} fallback={`待确认：${plan.pendingReason ?? ''}`}>
                                {routeChainText(plan.routePath, props.ponds)}
                              </Show>
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                )}
              </For>
            </div>
          </section>
        </div>
      </Show>

      {/* 放弃草稿二次确认 */}
      <Show when={discardOpen()}>
        <div class="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-8">
          <div class="w-full max-w-md rounded-xl bg-white shadow-2xl">
            <div class="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">放弃本次换线草稿？</div>
            <div class="px-4 py-4 text-sm leading-relaxed text-slate-600">
              未提交的候选拓扑将被删除，闸门串级保持原拓扑。已锁定批次不受影响。
            </div>
            <div class="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button class={BTN_GHOST} onClick={() => setDiscardOpen(false)}>
                取消
              </button>
              <button class={BTN_DANGER} onClick={() => void handleDiscard()}>
                放弃草稿
              </button>
            </div>
          </div>
        </div>
      </Show>
    </AppDialog>
  );
}
