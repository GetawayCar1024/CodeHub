import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/board-sort.js';
const sort = globalThis.CodeHubBoardSort.sort;
const rows = [
  { id: 1, username: 'user2', realName: 'Zoe', total: 0, cells: { a: { score: 0, judged: true } } },
  { id: 2, username: 'user10', realName: 'Anna', total: 80, cells: { a: { score: 80, judged: true } } },
  { id: 3, username: 'user1', realName: 'Mike', total: null, cells: { a: { score: 99, judged: false } } },
];
test('board score ordering preserves zeroes and keeps unjudged last both ways', () => {
  for (const key of ['total', 'problem:a']) {
    assert.deepEqual(sort(rows, key, -1).map(row => row.id), [2, 1, 3]);
    assert.deepEqual(sort(rows, key, 1).map(row => row.id), [1, 2, 3]);
  }
  assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);
});
test('account and real-name sorting remain available and deterministic', () => {
  assert.deepEqual(sort(rows).map(row => row.username), ['user1', 'user2', 'user10']);
  assert.deepEqual(sort(rows, 'realName').map(row => row.realName), ['Anna', 'Mike', 'Zoe']);
  const tied = rows.map(row => ({ ...row, total: 10 }));
  assert.deepEqual(sort(tied, 'total', -1).map(row => row.username), ['user1', 'user2', 'user10']);
});
