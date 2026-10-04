/* 临时逻辑冒烟测试：node --import tsx 不可用，故由 esbuild 即时编译 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const result = await build({
  entryPoints: ['src/utils/topology.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
});
writeFileSync('/tmp/topology.bundle.mjs', result.outputFiles[0].text);
const { traceRoute, planSwitchover, validateCandidateGates, cloneGatesToDraft } = await import(
  pathToFileURL('/tmp/topology.bundle.mjs').href
);

const stamp = '2026-10-01T00:00:00.000Z';
const pond = (id, code, seriesName, status = '在用') => ({ id, code, seriesName, areaM2: 1, depthCm: 1, stage: '钠盐', status, createdAt: stamp, updatedAt: stamp, revision: 3 });
const gate = (id, from, to, versionId, openingPct = 50, state = '半开') => ({ id, fromPondId: from, toPondId: to, openingPct, widthCm: 120, state, note: '', topologyVersionId: versionId, createdAt: stamp, updatedAt: stamp, revision: 3 });
const schedule = (id, pondId, state, orderIndex, planDate = '2026-10-05') => ({ id, pondId, planDate, targetDensity: 1.1, volumeM3: 1, operator: '', state, orderIndex, routeVersionId: 1, routePath: null, terminalPondId: null, pendingReason: null, routeLocked: false, createdAt: stamp, updatedAt: stamp, revision: 3 });

const ponds = [
  pond('a', '北-01', '北系'),
  pond('b', '北-02', '北系'),
  pond('c', '北-03', '北系', '停用'),
  pond('d', '南-04', '南系'),
  pond('e', '南-05', '南系'),
  pond('x', '孤-09', '北系'), // 无任何下游
];
// 旧拓扑 v1：a→b→c（c 在用时正常），d→e
const gatesV1 = [
  gate('g1', 'a', 'b', 1),
  gate('g2', 'b', 'c', 1),
  gate('g3', 'd', 'e', 1),
];

// --- 1. traceRoute：正常链路 ---
let t = traceRoute('a', gatesV1, ponds.map((p) => (p.id === 'c' ? { ...p, status: '在用' } : p)));
assert.deepEqual(t.path, ['a', 'b', 'c']);
assert.equal(t.terminalPondId, 'c');
assert.equal(t.pendingReason, null);

// --- 2. traceRoute：经过停用池 ---
t = traceRoute('a', gatesV1, ponds);
assert.deepEqual(t.path, ['a', 'b', 'c']);
assert.equal(t.terminalPondId, null);
assert.equal(t.pendingReason, '经过停用池');

// --- 3. traceRoute：找不到连续下游 ---
t = traceRoute('x', gatesV1, ponds);
assert.deepEqual(t.path, ['x']);
assert.equal(t.pendingReason, '找不到连续下游');

// --- 4. traceRoute：正常终点（下游池无后续闸门）不视为待确认 ---
t = traceRoute('d', gatesV1, ponds);
assert.deepEqual(t.path, ['d', 'e']);
assert.equal(t.terminalPondId, 'e');
assert.equal(t.pendingReason, null);

// --- 5. 新拓扑 v2：b→c 被删（c 停用截断），新增 a→e 跨系闸；d→e 保留 ---
const candidate = [
  gate('g1', 'a', 'b', 2, 60),
  gate('g4', 'a', 'e', 2, 80),
  gate('g3', 'd', 'e', 2, 80),
];
const schedules = [
  schedule('s-run', 'a', '走水中', 1, '2026-10-01'), // 锁定旧路线 a→b→c
  schedule('s-done', 'd', '已出卤', 2, '2026-09-20'), // 锁定旧路线 d→e
  schedule('s-new-a', 'a', '待排', 3, '2026-10-10'), // 重算：a→b 后无路（b 的新候选无出口）→ 实际 b 无出口=正常终点
  schedule('s-new-d', 'd', '已排', 4, '2026-10-11'), // 重算 d→e
  schedule('s-new-x', 'x', '待排', 5, '2026-10-12'), // 无连续下游 → 待确认
];
const plans = planSwitchover({ schedules, ponds, gates: gatesV1, candidateGates: candidate, newVersionId: 2 });
const byId = Object.fromEntries(plans.map((p) => [p.scheduleId, p]));

// 锁定项保留 v1 路线快照（即使路线经过停用池，锁定状态也不带待确认原因）
assert.equal(byId['s-run'].action, '锁定原路线');
assert.equal(byId['s-run'].routeVersionId, 1);
assert.deepEqual(byId['s-run'].routePath, ['a', 'b', 'c']);
assert.equal(byId['s-run'].routeLocked, true);
assert.equal(byId['s-run'].pendingReason, null);
assert.equal(byId['s-done'].routeVersionId, 1);

// 未开始项指向 v2
assert.equal(byId['s-new-d'].action, '按新拓扑重算');
assert.equal(byId['s-new-d'].routeVersionId, 2);
assert.deepEqual(byId['s-new-d'].routePath, ['d', 'e']);

// a 在新拓扑：同系闸 a→b 优先于跨系 a→e；b 无出口 → 正常终点
assert.equal(byId['s-new-a'].routeVersionId, 2);
assert.deepEqual(byId['s-new-a'].routePath, ['a', 'b']);
assert.equal(byId['s-new-a'].pendingReason, null);

// 孤立池 → 待确认
assert.equal(byId['s-new-x'].action, '进入待确认区');
assert.equal(byId['s-new-x'].pendingReason, '找不到连续下游');

// 全局次序唯一且连续；待确认项排在最后
const orders = plans.map((p) => p.newOrderIndex).sort((a, b) => a - b);
assert.deepEqual(orders, [1, 2, 3, 4, 5]);
assert.equal(byId['s-new-x'].newOrderIndex, 5);
// 同深度时按日期排序：d→e(10-11) 与 a→b(10-10) 深度均为1，a 在前
assert.ok(byId['s-new-a'].newOrderIndex < byId['s-new-d'].newOrderIndex);
// 锁定项（旧深度2）排在深度1的未开始项之后
assert.ok(byId['s-run'].newOrderIndex > byId['s-new-d'].newOrderIndex);

// --- 6. 校验：自环 / 重复串级 ---
const draftGates = cloneGatesToDraft(candidate);
draftGates.push({ draftId: 'z', sourceGateId: null, fromPondId: 'a', toPondId: 'a', openingPct: 50, widthCm: 120, state: '半开', note: '', removed: false });
const issues = validateCandidateGates(draftGates, ponds);
assert.ok(issues.some((i) => i.draftId === 'z' && i.message.includes('同一口池')));
const dup = validateCandidateGates(
  [...draftGates.filter((g) => g.draftId !== 'z'), { draftId: 'z2', sourceGateId: null, fromPondId: 'd', toPondId: 'e', openingPct: 10, widthCm: 120, state: '半开', note: '', removed: false }],
  ponds,
);
assert.ok(dup.some((i) => i.draftId === 'z2' && i.message.includes('重复串级')));

console.log('全部换线规划断言通过 ✓');
