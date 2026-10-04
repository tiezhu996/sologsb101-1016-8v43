/**
 * 闸门（Gate）
 * 连接上游池与下游池的串级通道，开度决定下游预计进水量。
 * 每条闸门归属于一个闸门串级（拓扑）版本；临时换线提交后，
 * 旧版本闸门原样保留，供已锁定批次继续引用。
 */

/** 闸门状态：关闭 / 半开 / 全开 */
export type GateState = '关闭' | '半开' | '全开'

export const GATE_STATE_OPTIONS: GateState[] = ['关闭', '半开', '全开']

export interface Gate {
  id: string
  /** 上游池 */
  fromPondId: string
  /** 下游池 */
  toPondId: string
  /** 开度（%） */
  openingPct: number
  /** 口宽（cm） */
  widthCm: number
  /** 闸门状态 */
  state: GateState
  /** 备注 */
  note: string
  /** 所属闸门串级（拓扑）版本 id */
  topologyVersionId: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑闸门的表单草稿（总是写入当前生效拓扑版本，无需手填） */
export interface GateDraft {
  fromPondId: string
  toPondId: string
  openingPct: number
  widthCm: number
  state: GateState
  note: string
}
