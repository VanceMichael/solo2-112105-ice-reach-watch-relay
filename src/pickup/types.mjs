// 来源适配器约定。
//
// 采集结果统一为 SourceSnapshot：
// {
//   fetchedAt: number,
//   releaseName: string|null,
//   boundary: object|null,            // /dispatch/boundary 原文
//   posts: object|null,               // /dispatch/posts 原文
//   books: Map<bookId, BookPickup>,
// }
// BookPickup:
// {
//   bookId, stationId,
//   complete: boolean,                // 是否取全部分页
//   pagesFetched: number,
//   next: string|null,                // 未取全时遗留的游标
//   error: object|null,               // {status,message} 取件失败原因
//   pages: Array<{cursor,rows,next}>  // 已取到的分页原文
// }
//
// 关键纪律：分页未取全时 complete=false，绝不可宣告“无记录”；
// 只有站点自己签发的 confirmed-gap 才是正式空窗。

export const BOOK_IDS = ['north', 'south'];

/** 汇总一本簿已取到的全部原始行。 */
export function collectedRows(bookPickup) {
  return bookPickup.pages.flatMap(page => page.rows);
}
