/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 该条计划当前使用的路线版本 */
  routeVersionId: string
  /** 途经池 id 链（含起点与终点）；待确认或无下游时可能只有起点 */
  routePath: string[]
  /** 路线终点池 id */
  routeEndPondId: string
  /** 已开始走水 / 已出卤后锁定，换线不再改其路线与次序 */
  routeLocked: boolean
  /** true = 路线经停用池或找不到连续下游，留在待确认区，需调度员人工确认 */
  routePending: boolean
  /** 待确认原因（经过停用池 / 找不到连续下游 / 串级成环等） */
  routeIssue: string
  /** 人工确认待确认路线后置 true（仍保留原因，供页面与导出标注） */
  routeConfirmed: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
