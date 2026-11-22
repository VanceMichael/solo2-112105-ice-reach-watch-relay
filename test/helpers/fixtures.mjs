// 测试辅助：从 sources/exchange.json 构造内存快照；以及对接真实 HTTP 联调站。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadCatalogue, scenarioFromCatalogue } from '../../src/pickup/scenario.mjs';
import { createMemorySource } from '../../src/pickup/memory-source.mjs';
import { collectSnapshot } from '../../src/pickup/http-source.mjs';
import { openOrigin } from '../../origin/test-origin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const CATALOGUE_PATH = resolve(here, '../../sources/exchange.json');
export const REQUESTS_PATH = resolve(here, '../../sources/requests.json');

export function catalogue() {
  return loadCatalogue(CATALOGUE_PATH);
}

export function requests() {
  return JSON.parse(readFileSync(REQUESTS_PATH, 'utf8')).relays;
}

export async function snapshotOf(releaseName) {
  const scenario = scenarioFromCatalogue(catalogue(), releaseName);
  return createMemorySource(scenario).collectSnapshot();
}

/** 启动真实联调站，切到指定发布档，再走 HTTP 适配器采集。 */
export async function httpSnapshot(t, releaseName) {
  const base = await openOrigin(t);
  const switched = await fetch(base + '/_desk/releases/' + encodeURIComponent(releaseName), { method: 'POST' });
  if (!switched.ok) throw new Error('切换发布档失败');
  return collectSnapshot(base);
}
