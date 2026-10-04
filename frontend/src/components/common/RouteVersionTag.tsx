/**
 * <RouteVersionTag> 走水计划的路线版本与路线标记
 * 显示该计划依据的闸门串级版本（路线 vN）、是否已锁定原路线；
 * 待确认项额外标出原因。/schedules 列表、/gates 换线预览与导出共用。
 */
import { Show } from 'solid-js';
import type { Schedule } from '../../types/schedule';
import type { Pond } from '../../types/pond';
import { routeChainText } from '../../utils/topology';

export interface RouteVersionTagProps {
  schedule: Pick<Schedule, 'routeVersionId' | 'routeLocked' | 'pendingReason' | 'routePath'>;
  ponds?: Pond[];
  /** 是否同时展开路线池号链 */
  showPath?: boolean;
  size?: 'sm' | 'md';
}

export default function RouteVersionTag(props: RouteVersionTagProps) {
  const padding = (): string => (props.size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]');
  return (
    <span class="inline-flex flex-wrap items-center gap-1 align-middle">
      <span
        class={`rounded border tabular-nums ${padding()} ${
          props.schedule.routeLocked
            ? 'border-amber-300 bg-amber-50 text-amber-700'
            : props.schedule.pendingReason !== null
              ? 'border-rose-300 bg-rose-50 text-rose-700'
              : 'border-slate-300 bg-slate-50 text-slate-600'
        }`}
        title={
          props.schedule.routeLocked
            ? `已锁定路线 v${props.schedule.routeVersionId}，临时换线不会改变该批次走向`
            : props.schedule.pendingReason !== null
              ? `待确认：${props.schedule.pendingReason}`
              : `按路线 v${props.schedule.routeVersionId} 的当前闸门串级执行`
        }
      >
        路线 v{props.schedule.routeVersionId}
        <Show when={props.schedule.routeLocked}>· 已锁定</Show>
      </span>
      <Show when={props.schedule.pendingReason !== null}>
        <span class={`rounded border border-rose-300 bg-rose-50 text-rose-700 ${padding()}`}>
          待确认·{props.schedule.pendingReason}
        </span>
      </Show>
      <Show when={props.showPath && props.ponds !== undefined}>
        <span class="text-[11px] text-slate-500">{routeChainText(props.schedule.routePath, props.ponds ?? [])}</span>
      </Show>
    </span>
  );
}
