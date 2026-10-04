/**
 * 路线版本（RouteVersion）
 * 闸门串级拓扑的快照版本。每次临时换线提交都会生成新版本并置为在用；
 * 旧版本与其闸门整组保留：已开始走水或已出卤的批次锁定原路线，仍可按旧版本追溯走向。
 */

/** 初始路线版本（v3 迁移前既有的全部闸门串级归入此版本） */
export const INITIAL_ROUTE_VERSION_ID = 'route-v1';
export const INITIAL_ROUTE_VERSION_CODE = 'V1';

export interface RouteVersion {
  id: string
  /** 版本号文案，如 V1 / V2 */
  code: string
  /** 是否在用（同一时间仅一个在用版本） */
  isActive: boolean
  /** 提交换线的调度员 */
  operator: string
  /** 换线说明 */
  note: string
  createdAt: string
  committedAt: string
  revision: number
}
