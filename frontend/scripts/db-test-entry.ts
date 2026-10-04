/* db 换线事务测试入口（被 scripts/test-db.mjs 打包执行） */
import assert from 'node:assert/strict';
import {
  commitSwitchover,
  db,
  getSwitchDraft,
  initDatabase,
  listTopologyVersions,
  putPond,
  putSwitchDraft,
  recheckPendingSchedules,
  removePond,
  saveScheduleWithRoute,
  SWITCH_DRAFT_ID,
  updateGateOpening,
} from '../src/utils/db';
import type { Pond } from '../src/types/pond';
import type { Gate } from '../src/types/gate';
import type { Schedule } from '../src/types/schedule';
import type { SwitchDraft } from '../src/types/topology';
import { INITIAL_TOPOLOGY_ID } from '../src/types/topology';
import { nowIso } from '../src/utils/id';

const stamp = nowIso();

function pond(id: string, code: string, seriesName: string, status: Pond['status'] = '在用'): Pond {
  return { id, code, seriesName, areaM2: 1000, depthCm: 40, stage: '钠盐', status, createdAt: stamp, updatedAt: stamp, revision: 3 };
}
function gate(id: string, from: string, to: string, openingPct = 50): Gate {
  return { id, fromPondId: from, toPondId: to, openingPct, widthCm: 120, state: openingPct > 0 ? '半开' : '关闭', note: '', topologyVersionId: INITIAL_TOPOLOGY_ID, createdAt: stamp, updatedAt: stamp, revision: 3 };
}
function schedule(row: Partial<Schedule> & Pick<Schedule, 'id' | 'pondId' | 'state'>): Schedule {
  return {
    planDate: '2026-10-05',
    targetDensity: 1.1,
    volumeM3: 100,
    operator: '',
    orderIndex: 1,
    routeVersionId: 0,
    routePath: null,
    terminalPondId: null,
    pendingReason: null,
    routeLocked: false,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
    ...row,
  };
}

export async function run(assertMod: typeof assert): Promise<void> {
  const assert = assertMod;
  await initDatabase();
  // 清掉播种数据，构造自定义场景
  await Promise.all([db.ponds.clear(), db.gates.clear(), db.schedules.clear(), db.topologyVersions.clear(), db.switchDrafts.clear()]);

  const ponds = [pond('a', '北-01', '北系'), pond('b', '北-02', '北系'), pond('c', '北-03', '北系'), pond('d', '南-04', '南系'), pond('e', '南-05', '南系')];
  await db.ponds.bulkPut(ponds);
  await db.topologyVersions.put({ id: 1, name: '初始串级 v1', note: '', operator: '', appliedAt: stamp, createdAt: stamp, updatedAt: stamp, revision: 3 });
  await db.gates.bulkPut([gate('g-ab', 'a', 'b', 60), gate('g-bc', 'b', 'c', 40), gate('g-de', 'd', 'e', 80)]);

  const running = schedule({ id: 's-run', pondId: 'b', state: '走水中', orderIndex: 1, planDate: '2026-10-01' });
  const waiting = schedule({ id: 's-wait', pondId: 'a', state: '待排', orderIndex: 2, planDate: '2026-10-10' });
  const waitingD = schedule({ id: 's-d', pondId: 'd', state: '已排', orderIndex: 3, planDate: '2026-10-11' });
  await saveScheduleWithRoute(running);
  await saveScheduleWithRoute(waiting);
  await saveScheduleWithRoute(waiting);
  await saveScheduleWithRoute(waitingD);

  let runRow = (await db.schedules.get('s-run'))!;
  assert.equal(runRow.routeLocked, true);
  assert.deepEqual(runRow.routePath, ['b', 'c']);
  assert.equal(runRow.routeVersionId, 1);

  // 未提交草稿：构造新拓扑 = 删掉 b→c（c 改停用），a 无连续下游（a→b 后 b 无出口属正常终点，不是待确认）
  // 为制造「找不到连续下游」，把 g-ab 也删掉 → a 起点无任何下游
  const draft: SwitchDraft = {
    id: SWITCH_DRAFT_ID,
    gates: [
      { draftId: 'g-ab', sourceGateId: 'g-ab', fromPondId: 'a', toPondId: 'b', openingPct: 60, widthCm: 120, state: '半开', note: '', removed: true },
      { draftId: 'g-bc', sourceGateId: 'g-bc', fromPondId: 'b', toPondId: 'c', openingPct: 40, widthCm: 120, state: '半开', note: '', removed: true },
      { draftId: 'g-de', sourceGateId: 'g-de', fromPondId: 'd', toPondId: 'e', openingPct: 80, widthCm: 120, state: '半开', note: '', removed: false },
    ],
    note: '北线临时停用',
    operator: '调度员甲',
    baseVersionId: 1,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  };
  await putSwitchDraft(draft);
  assert.notEqual(await getSwitchDraft(), null);

  // 先把 c 改为停用（不影响 d 系列）
  await putPond({ ...ponds.find((p) => p.id === 'c')!, status: '停用' });

  // 候选新拓扑：北线 a→b 被移除（a 起点无下游 → 待确认），b→c 与 d→e 保留
  const candidate: Gate[] = [gate('g-bc', 'b', 'c', 40), gate('g-de', 'd', 'e', 80)];
  const version = await commitSwitchover({ note: '北线临时停用', operator: '调度员甲', candidateGates: candidate });
  assert.equal(version.id, 2);
  assert.equal(version.name, '临时换线 v2');

  const versions = await listTopologyVersions();
  assert.equal(versions.length, 2);

  // 旧闸门全部保留（锁定批次引用 v1）
  // 旧版本闸门：未被新拓扑保留的 g-ab（已删除）随旧版本保留 3 条快照供锁定引用
  const allGates = await db.gates.toArray();
  const v1Gates = allGates.filter((g) => g.topologyVersionId === 1);
  assert.equal(v1Gates.length, 3);
  const v2Gates = allGates.filter((g) => g.topologyVersionId === 2);
  assert.equal(v2Gates.length, 2);
  // 新拓扑里不再有 g-ab（工作区中标记删除）
  assert.equal(v2Gates.some((g) => g.id === 'g-ab'), false);

  // 走水中批次锁定原路线 v1
  runRow = (await db.schedules.get('s-run'))!;
  assert.equal(runRow.routeLocked, true);
  assert.equal(runRow.routeVersionId, 1);
  assert.deepEqual(runRow.routePath, ['b', 'c']);

  // a 的未开始计划：新拓扑无下游 → 待确认
  const waitRow = (await db.schedules.get('s-wait'))!;
  assert.equal(waitRow.routeVersionId, 2);
  assert.equal(waitRow.pendingReason, '找不到连续下游');
  assert.equal(waitRow.routeLocked, false);

  // d 的未开始计划：重算 d→e
  const dRow = (await db.schedules.get('s-d'))!;
  assert.equal(dRow.routeVersionId, 2);
  assert.equal(dRow.pendingReason, null);
  assert.deepEqual(dRow.routePath, ['d', 'e']);

  // 提交成功后草稿被删除
  assert.equal(await getSwitchDraft(), null);

  // orderIndex 全局连续，待确认项（a）排最后
  const rows = await db.schedules.toArray();
  const orders = rows.map((r) => r.orderIndex).sort((x, y) => x - y);
  assert.deepEqual(orders, [1, 2, 3]);
  assert.equal(waitRow.orderIndex, 3);

  // --- 复查：v2 关掉 b→停用池c 的闸、新增 a→b 后，a→b 成为正常终点，待确认归队 ---
  await db.gates.put({ ...gate('g-ab2', 'a', 'b', 60), topologyVersionId: 2 });
  await db.gates.update('v2-g-bc', { state: '关闭', openingPct: 0 });
  const cleared1 = await recheckPendingSchedules();
  assert.equal(cleared1, 1);
  const waitRow2 = (await db.schedules.get('s-wait'))!;
  assert.equal(waitRow2.pendingReason, null);
  assert.deepEqual(waitRow2.routePath, ['a', 'b']);

  // --- 提交失败回滚：构造自环候选触发事务抛错，确认原拓扑与草稿保留 ---
  await putSwitchDraft(draft);
  const beforeGates = await db.gates.toArray();
  const badCandidate: Gate[] = [
    gate('g-bc', 'b', 'c', 40),
    gate('g-de', 'd', 'e', 80),
    gate('bad', 'a', 'a', 50),
  ];
  await assert.rejects(
    commitSwitchover({ note: 'bad', operator: '', candidateGates: badCandidate }),
  );
  // 回滚：没有 v3 版本、闸门集合不变、草稿仍在
  const afterVersions = await listTopologyVersions();
  assert.equal(afterVersions.length, 2);
  const afterGates = await db.gates.toArray();
  assert.equal(afterGates.length, beforeGates.length);
  assert.notEqual(await getSwitchDraft(), null);

  // --- 开度调整只写指定闸门（此处调整 v2 下的 d→e，不影响 v1 快照） ---
  await updateGateOpening('v2-g-de', 30, '半开');
  const deV2 = (await db.gates.get('v2-g-de'))!;
  assert.equal(deV2.openingPct, 30);
  const deV1 = (await db.gates.get('g-de'))!;
  assert.equal(deV1.openingPct, 80);

  // --- 删除池级联：删除 e 后 d→e 闸（各版本）被删，d 计划进入待确认 ---
  await removePond('e');
  const dAfter = (await db.schedules.get('s-d'))!;
  assert.equal(dAfter.pendingReason, '找不到连续下游');
  assert.equal(await db.gates.where('toPondId').equals('e').count(), 0);

  // 锁定批次次序不被重排改动（s-run 的 orderIndex 在删除池前后保持）
  const runAfter = (await db.schedules.get('s-run'))!;
  assert.equal(runAfter.orderIndex, runRow.orderIndex);
  assert.equal(runAfter.routeLocked, true);

  console.log('全部 db 换线事务断言通过 ✓');
}
