// Stable score/name ordering shared by the board and its regression tests.
(function (root) {
  const names = new Intl.Collator('zh-CN', { numeric: true });
  const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  function sort(rows, key = 'username', direction = 1) {
    const numeric = key === 'total' || key.startsWith('problem:');
    const value = row => key === 'total' ? score(row.total) : key.startsWith('problem:')
      ? score(row.cells?.[key.slice(8)]?.judged ? row.cells[key.slice(8)].score : null) : String(row[key] || '');
    return rows.slice().sort((a, b) => {
      const left = value(a), right = value(b);
      if (numeric && (left === null || right === null)) {
        if (left !== right) return left === null ? 1 : -1; // unjudged stays last in either direction
      }
      const order = numeric ? (left ?? 0) - (right ?? 0) : names.compare(left, right);
      return order * direction || names.compare(a.username, b.username) || a.id - b.id;
    });
  }
  root.CodeHubBoardSort = { sort };
})(globalThis);
