/**
 * 闸门串级（拓扑）版本与临时换线草稿
 *
 * 盐田临时换线时调度员会改动闸门串级：正在走水 / 已出卤的批次不能
 * 跟着新拓扑走，必须锁定换线前的原路线；未开始的走水计划则要按新
 * 拓扑重算终点与次序。每次成功提交换线都会生成一个新版本，旧版本
 * 闸门原样保留，供锁定批次继续引用。
 */
import type { GateDraft } from './gate';

/** 初始拓扑版本 id（v3 升级与播种时使用） */
export const INITIAL_TOPOLOGY_ID = 1;

/** 走水计划待确认原因：经过停用池，或找不到连续下游 */
export type PendingReason = '经过停用池' | '找不到连续下游';

export interface TopologyVersion {
  /** 单调递增的版本号，即路线版本号 */
  id: number
  /** 版本名称，如「临时换线 v2」 */
  name: string
  /** 换线原因 / 备注 */
  note: string
  /** 提交换线的调度员 */
  operator: string
  /** 提交时间 */
  appliedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/**
 * 临时换线草稿：提交失败、关闭页面或放弃前都保留在 IndexedDB，
 * 重开页面可以继续编辑；提交成功后删除。
 */
export interface SwitchDraft {
  /** 固定单行主键 */
  id: string
  /** 候选闸门（含新增 / 删除标记的工作副本） */
  gates: SwitchDraftGate[]
  note: string
  operator: string
  /** 基准拓扑版本（打开换线时的生效版本） */
  baseVersionId: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 换线工作区里的闸门副本：编辑中的删除标记不直接落库 */
export interface SwitchDraftGate extends GateDraft {
  /** 已有闸门沿用原 id；新增闸门在提交时换发正式 id */
  draftId: string
  /** 由哪个现有闸门克隆而来（新增闸门为 null） */
  sourceGateId: string | null
  /** 工作区内标记删除 */
  removed: boolean
}
