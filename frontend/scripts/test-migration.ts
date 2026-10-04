/* v2 → v3 升级迁移测试：用旧版 Dexie 先建 v2 结构数据，再打开当前 db 触发 upgrade */
// 注意：必须先挂好 IndexedDB 全局，再动态导入 db 模块（静态导入会被提升提前执行）
import IDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
import assert from 'node:assert/strict';

// 全新内存 IndexedDB（必须在任何 Dexie 打开前挂到全局）
globalThis.indexedDB = new IDBFactory() as unknown as typeof globalThis.indexedDB;
globalThis.IDBKeyRange = FDBKeyRange as unknown as typeof IDBKeyRange;

const { default: Dexie } = await import('dexie');

// 1) 用独立 Dexie 实例按 v2 结构写旧数据
class OldDb extends Dexie {
  constructor() {
    super('gbbrinepond');
    this.version(2).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
      gates: 'id, fromPondId, toPondId, state, openingPct',
      observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
      assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });
  }
}
const old = new OldDb();
await old.open();
await old.table('ponds').bulkPut([
  { id: 'a', code: '北-01', seriesName: '北系', areaM2: 1, depthCm: 40, stage: '钠盐', status: '在用', createdAt: 't', updatedAt: 't' },
  { id: 'b', code: '北-02', seriesName: '北系', areaM2: 1, depthCm: 40, stage: '钾盐', status: '在用', createdAt: 't', updatedAt: 't' },
  { id: 'z', code: '孤-00', seriesName: '北系', areaM2: 1, depthCm: 40, stage: '钠盐', status: '在用', createdAt: 't', updatedAt: 't' },
]);
await old.table('gates').bulkPut([
  { id: 'g1', fromPondId: 'a', toPondId: 'b', openingPct: 60, widthCm: 120, state: '半开', createdAt: 't', updatedAt: 't' },
]);
await old.table('schedules').bulkPut([
  { id: 's1', pondId: 'a', planDate: '2026-10-01', targetDensity: 1.1, volumeM3: 1, operator: '', state: '走水中', orderIndex: 1 },
  { id: 's2', pondId: 'z', planDate: '2026-10-02', targetDensity: 1.1, volumeM3: 1, operator: '', state: '待排', orderIndex: 2 },
]);
await old.close();

// 2) 打开当前应用 db（v3）触发 upgrade（此时 ponds 非空，不会播种）
const { db, DB_SCHEMA_VERSION } = await import('../src/utils/db');
assert.equal(DB_SCHEMA_VERSION, 3);
await db.open();

const versions = await db.topologyVersions.toArray();
assert.equal(versions.length, 1);
assert.equal(versions[0].id, 1);

const gates = await db.gates.toArray();
assert.equal(gates[0].topologyVersionId, 1);

const s1 = await db.schedules.get('s1');
assert.equal(s1.routeLocked, true);
assert.equal(s1.routeVersionId, 1);
assert.deepEqual(s1.routePath, ['a', 'b']);
assert.equal(s1.pendingReason, null);

const s2 = await db.schedules.get('s2');
assert.equal(s2.routeLocked, false);
assert.equal(s2.routeVersionId, 1);
assert.equal(s2.pendingReason, '找不到连续下游');

console.log('v2→v3 迁移断言通过 ✓');
process.exit(0);
