/**
 * 临时换线草稿（LineChangeDraft）
 * 调度员在闸门配置页发起换线时，先在草稿里改串级（删除 / 新增 / 改向 / 调开度），
 * 系统按池系预览受影响计划；草稿按池系持久化，提交失败或关掉重开都能继续。
 */
import type { GateState } from './gate';

/** 草稿中的单条闸门行：gateId 为空表示新增，removed=true 表示删除旧版本中的该闸 */
export interface LineChangeGateDraft {
  /** 草稿行前端主键 */
  clientId: string
  /** 原闸门 id（新增行为空串） */
  gateId: string
  fromPondId: string
  toPondId: string
  openingPct: number
  widthCm: number
  state: GateState
  note: string
  removed: boolean
}

export interface LineChangeDraft {
  /** 按池系生成：draft::<池系名>，同一池系只保留一份草稿 */
  id: string
  seriesName: string
  /** 草稿基线（发起时的在用路线版本 id） */
  baseVersionId: string
  operator: string
  note: string
  gates: LineChangeGateDraft[]
  createdAt: string
  updatedAt: string
  revision: number
}

export const lineChangeDraftId = (seriesName: string): string => `draft::${seriesName}`;
