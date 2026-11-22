// HTTP 来源适配器：对接资料联调站（或任何同协议来源）。
// 仅使用 Node 标准库；分页以 next 游标延续，非 2xx / 网络错误都记为取件未全，不抛断整班采集。

import { BOOK_IDS } from './types.mjs';

async function getJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { ok: false, status: 0, error: { status: 0, message: `网络错误: ${err.message}` } };
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = JSON.parse(text).error ?? message; } catch { /* 保留状态码信息 */ }
    return { ok: false, status: response.status, error: { status: response.status, message } };
  }
  try {
    return { ok: true, status: response.status, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, status: response.status, error: { status: response.status, message: `响应不是合法 JSON: ${err.message}` } };
  }
}

/** 逐页拉取一本值守簿；任何一页失败都保留已取内容并标记 complete=false。 */
async function collectBook(base, bookId, { maxPages = 100 } = {}) {
  const pickup = {
    bookId,
    stationId: bookId,
    complete: false,
    pagesFetched: 0,
    next: null,
    error: null,
    pages: [],
  };

  let cursor = null;
  for (let guard = 0; guard < maxPages; guard++) {
    const url = new URL(`${base}/books/${bookId}`);
    if (cursor) url.searchParams.set('cursor', cursor);

    const result = await getJson(url.toString());
    if (!result.ok) {
      pickup.next = cursor;
      pickup.error = result.error;
      return pickup;
    }
    const data = result.data;
    pickup.pages.push({ cursor, rows: Array.isArray(data.rows) ? data.rows : [], next: data.next ?? null });
    pickup.pagesFetched += 1;

    if (data.next === null || data.next === undefined) {
      pickup.complete = true;
      pickup.next = null;
      return pickup;
    }
    cursor = data.next;
  }

  pickup.next = cursor;
  pickup.error = { status: 0, message: `分页超过上限 ${maxPages} 页，停止续取` };
  return pickup;
}

/**
 * 执行一次完整采集。
 * @param {string} base 来源根地址
 * @param {object} options {books: 指定簿，默认 north/south}
 */
export async function collectSnapshot(base, options = {}) {
  const books = options.books ?? BOOK_IDS;
  const snapshot = {
    fetchedAt: Date.now(),
    releaseName: null,
    base,
    boundary: null,
    posts: null,
    boundaryError: null,
    postsError: null,
    books: new Map(),
  };

  const release = await getJson(`${base}/_desk/releases`);
  if (release.ok) snapshot.releaseName = release.data.current;

  const [boundary, posts] = await Promise.all([
    getJson(`${base}/dispatch/boundary`),
    getJson(`${base}/dispatch/posts`),
  ]);
  if (boundary.ok) snapshot.boundary = boundary.data;
  else snapshot.boundaryError = boundary.error;
  if (posts.ok) snapshot.posts = posts.data;
  else snapshot.postsError = posts.error;

  const pickups = await Promise.all(books.map(id => collectBook(base, id, options)));
  for (const pickup of pickups) snapshot.books.set(pickup.bookId, pickup);

  return snapshot;
}
