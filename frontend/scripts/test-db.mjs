/* db 层端到端冒烟测试（经 esbuild 打包，注入 fake-indexeddb） */
import 'fake-indexeddb/auto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const result = await build({
  entryPoints: ['scripts/db-test-entry.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
});
writeFileSync('/tmp/db-test.bundle.mjs', result.outputFiles[0].text);
const mod = await import(pathToFileURL('/tmp/db-test.bundle.mjs').href);
await mod.run(assert);
rmSync('/tmp/db-test.bundle.mjs', { force: true });
