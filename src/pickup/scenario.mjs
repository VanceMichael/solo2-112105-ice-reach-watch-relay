// 把资料联调站 exchange.json 的某档发布路由，转成内存适配器可吃的 scenario。
// 这样同一套合成资料既能走 HTTP 联调，也能离线驱动交接引擎与测试。

import { readFileSync } from 'node:fs';

export function loadCatalogue(cataloguePath) {
  return JSON.parse(readFileSync(cataloguePath, 'utf8'));
}

/** 按发布名取一档；找不到时抛错并列出可选档位。 */
export function scenarioFromCatalogue(catalogue, releaseName) {
  const release = catalogue.releases.find(r => r.name === releaseName);
  if (!release) {
    throw new Error(`没有发布「${releaseName}」，可选：${catalogue.releases.map(r => r.name).join('、')}`);
  }
  return scenarioFromRoutes(release.name, release.routes);
}

/** 由路由表构造 scenario（路由键形如 "/books/south" 与 "/books/south?cursor=next23"）。 */
export function scenarioFromRoutes(releaseName, routes) {
  const boundary = routes['/dispatch/boundary'];
  const posts = routes['/dispatch/posts'];
  const scenario = { releaseName, boundary, posts, books: {}, failures: {} };

  for (const bookId of ['north', 'south']) {
    const home = routes[`/books/${bookId}`];
    if (!home) continue;
    scenario.books[bookId] = [];

    // 失败页（如 503）登记为该游标的取件失败
    if (home.status && home.status !== 200) {
      scenario.failures[bookId] = {
        null: { status: home.status, message: safeError(home.text) },
      };
      continue;
    }

    scenario.books[bookId].push({ rows: home.rows ?? [], next: home.next ?? null });
    let cursor = home.next ?? null;
    while (cursor) {
      const page = routes[`/books/${bookId}?cursor=${cursor}`];
      if (!page) {
        scenario.failures[bookId] = {
          ...(scenario.failures[bookId] ?? {}),
          [cursor]: { status: 404, message: '来源没有该分页地址' },
        };
        break;
      }
      if (page.status && page.status !== 200) {
        scenario.failures[bookId] = {
          ...(scenario.failures[bookId] ?? {}),
          [cursor]: { status: page.status, message: safeError(page.text) },
        };
        break;
      }
      scenario.books[bookId].push({ rows: page.rows ?? [], next: page.next ?? null });
      cursor = page.next ?? null;
    }
  }
  return scenario;
}

function safeError(text) {
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}
