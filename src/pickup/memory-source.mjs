// 内存来源适配器：用于离线演练与单元测试，产出与 HTTP 适配器同构的 SourceSnapshot。
//
// scenario 结构：
// {
//   releaseName: '改派',
//   boundary: { … /dispatch/boundary 原文 … },
//   posts:    { aliases: [ … ] },
//   books: {
//     north: [ { rows: [...], next: null } ],
//     south: [ { rows: [...], next: 'next23' }, { rows: [...], next: null } ],
//   },
//   failures: { south: { next23: { status: 503, message: '岸站正在归档' } } }
// }
// failures 模拟某游标取件失败：该簿保留已取分页并标记 complete=false。

import { BOOK_IDS } from './types.mjs';

export function createMemorySource(scenario) {
  return {
    async collectSnapshot(options = {}) {
      const books = options.books ?? BOOK_IDS;
      const snapshot = {
        fetchedAt: options.at ?? Date.now(),
        releaseName: scenario.releaseName ?? null,
        base: 'memory://scenario',
        boundary: scenario.boundary ?? null,
        posts: scenario.posts ?? null,
        boundaryError: scenario.boundary ? null : { status: 0, message: '场景缺少调度责任线' },
        postsError: scenario.posts ? null : { status: 0, message: '场景缺少站位公示' },
        books: new Map(),
      };

      for (const bookId of books) {
        const pages = scenario.books?.[bookId] ?? [];
        const failures = scenario.failures?.[bookId] ?? {};
        const pickup = {
          bookId,
          stationId: bookId,
          complete: false,
          pagesFetched: 0,
          next: null,
          error: null,
          pages: [],
        };

        // pages[0] 为首页（cursor=null），后续页按上一页 next 顺序取用。
        // 每页先检查“进入该页所用游标”是否在 failures 中：失败则保留已取内容并标记未取全。
        for (let index = 0; index < pages.length; index++) {
          const cursor = index === 0 ? null : pages[index - 1].next;
          const failure = failures[cursor] ?? (cursor === null ? failures.null : undefined);
          if (failure) {
            pickup.next = cursor ?? (pickup.pages.at(-1)?.next ?? null);
            pickup.error = { ...failure };
            break;
          }
          const page = pages[index];
          pickup.pages.push({ cursor, rows: Array.isArray(page.rows) ? page.rows : [], next: page.next ?? null });
          pickup.pagesFetched += 1;
          if (page.next === null || page.next === undefined) {
            pickup.complete = true;
            break;
          }
          // 末页已处理但仍声明了下一页游标：该页可能缺失或被 failures 登记
          if (index === pages.length - 1) {
            const pendingCursor = page.next;
            const pendingFailure = failures[pendingCursor];
            if (pendingFailure) {
              pickup.next = pendingCursor;
              pickup.error = { ...pendingFailure };
            } else {
              // 来源声称还有页但场景未提供：同样按取件未全处理，绝不宣告无记录
              pickup.next = pendingCursor;
              pickup.error = { status: 0, message: `缺少游标 ${pendingCursor} 的分页数据` };
            }
          }
        }

        if (pickup.pages.length === 0) {
          pickup.error = pickup.error ?? { status: 0, message: '值守簿无首页数据' };
        }
        snapshot.books.set(bookId, pickup);
      }
      return snapshot;
    },
  };
}
