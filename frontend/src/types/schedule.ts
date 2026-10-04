/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 *
 * 路线版本：每条计划都记录它所依据的闸门串级版本与计算出来的路线。
 * 临时换线时，已开始（走水中）或已出卤的批次会把换线前路线锁定在
 * routePath 上；未开始的计划按新拓扑重算；路线经过停用池或找不到
 * 连续下游时进入待确认区（pendingReason 非空）。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 换线时需要锁定原路线的状态：已经开始走水 / 已经出卤 */
export const LOCKED_STATES: ScheduleState[] = ['走水中', '已出卤']

/** 未开始、必须跟随新拓扑重算的状态 */
export const UNSTARTED_STATES: ScheduleState[] = ['待排', '已排']

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
  /** 使用的闸门串级（路线）版本号 */
  routeVersionId: number
  /** 锁定的路线（池 id 链，起点即 pondId）；待确认时可为 null */
  routePath: string[] | null
  /** 路线终点池 id；待确认时为 null */
  terminalPondId: string | null
  /** 待确认原因；非空表示停在待确认区，等待人工处理 */
  pendingReason: '经过停用池' | '找不到连续下游' | null
  /** 换线时是否锁定原路线（走水中 / 已出卤批次） */
  routeLocked: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿（路线字段由当前拓扑自动计算） */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
