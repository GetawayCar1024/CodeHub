import { fail } from './http.js';

export function exportUsers(data, query) {
  let users = data.users.filter(user => user.role !== 'admin');
  const selected = query.get('ids');
  if (selected) {
    const ids = selected.split(',').map(Number);
    if (ids.some(id => !Number.isSafeInteger(id) || !users.some(user => user.id === id))) fail(400, '导出的用户不存在');
    users = users.filter(user => ids.includes(user.id));
  } else if (query.get('group')) {
    const group = query.get('group');
    if (group === 'none') users = users.filter(user => !user.groups?.length);
    else {
      const id = Number(group);
      if (!data.groups.some(item => item.id === id)) fail(400, '分组不存在');
      users = users.filter(user => user.groups?.includes(id));
    }
  }
  users.sort((a, b) => a.username.localeCompare(b.username, 'zh-CN', { numeric: true }));
  const format = query.get('format') || 'csv';
  const rows = users.map(user => ({ username: user.username, realName: user.realName,
    groups: (user.groups || []).map(id => data.groups.find(group => group.id === id)?.name).filter(Boolean) }));
  if (format === 'json') return { body: JSON.stringify(rows, null, 2), name: 'users.json', mime: 'application/json; charset=utf-8' };
  if (!['csv', 'tsv', 'txt'].includes(format)) fail(400, '请选择 CSV、TSV、TXT 或 JSON');
  const delimiter = format === 'csv' ? ',' : '\t';
  const cell = value => {
    let text = String(value ?? '');
    if (/^\s*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
    return /["\r\n]/.test(text) || text.includes(delimiter) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  const lines = [['用户名', '真实姓名', '分组'], ...rows.map(user => [user.username, user.realName, user.groups.join(';')])];
  return { body: '\uFEFF' + lines.map(row => row.map(cell).join(delimiter)).join('\r\n'), name: 'users.' + format,
    mime: format === 'csv' ? 'text/csv; charset=utf-8' : format === 'tsv' ? 'text/tab-separated-values; charset=utf-8' : 'text/plain; charset=utf-8' };
}
