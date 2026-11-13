import { fail } from './http.js';

// The same columns as the import format, so an exported file can be imported again. Passwords are
// never exported: the column stays empty (an existing user keeps their password when overwritten).
export const USER_COLUMNS = ['用户名', '密码', '真实姓名', '分组'];

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
    // the import also accepts "，" and ";" inside group lists, so quote whatever could split a cell
    return /["\r\n,，\t]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  const lines = [USER_COLUMNS, ...rows.map(user => [user.username, '', user.realName, user.groups.join(';')])];
  return { body: '\uFEFF' + lines.map(row => row.map(cell).join(delimiter)).join('\r\n'), name: 'users.' + format,
    mime: format === 'csv' ? 'text/csv; charset=utf-8' : format === 'tsv' ? 'text/tab-separated-values; charset=utf-8' : 'text/plain; charset=utf-8' };
}

// Rows of cells. Quoted cells may contain delimiters, quotes ("") and line breaks. A file whose first
// line has a tab outside quotes is tab separated; otherwise "," and "，" separate cells.
export function parseTable(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || '';
  const tabs = firstLine.replace(/"[^"]*"/g, '').includes('\t');
  const isDelimiter = (ch) => (tabs ? ch === '\t' : ch === ',' || ch === '，');
  const rows = [];
  let row = [], cell = '', quoted = false, wasQuoted = false, line = 1, rowLine = 1;
  const endCell = () => {
    let value = wasQuoted ? cell : cell.trim();
    // undo the spreadsheet formula guard of the export
    if (/^'(\s*[=+@-]|[\t\r])/.test(value)) value = value.slice(1);
    row.push(value);
    cell = ''; wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((x) => x !== '')) rows.push({ line: rowLine, cells: row });
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && !cell.trim()) {
      quoted = true; wasQuoted = true; cell = '';
    } else if (isDelimiter(ch)) endCell();
    else if (ch === '\r' && text[i + 1] === '\n') continue;
    else if (ch === '\n' || ch === '\r') { endRow(); line++; rowLine = line; }
    else if (!(wasQuoted && /\s/.test(ch))) cell += ch;
  }
  if (cell || row.length || wasQuoted) endRow();
  return rows;
}

const HEADERS = {
  username: /^(用户名|账号|帐号|username|user|account)$/i,
  password: /^(密码|password)$/i,
  realName: /^(真实姓名|姓名|名字|realname|real name|name)$/i,
  groups: /^(分组|组|groups?)$/i,
};

// Rows of {line, username, password, realName, groups}. Without a header row the columns are
// "username,password[,real name[,group;group]]"; with one, they are found by name (so the files
// exported by 0.1.11 / 0.1.12, without a password column, are read correctly too).
export function parseUserRows(text) {
  const table = parseTable(text);
  const positions = { username: 0, password: 1, realName: 2, groups: 3 };
  let columns = positions;
  if (table.length && HEADERS.username.test(table[0].cells[0] || '')) {
    const header = table.shift().cells;
    columns = {};
    for (const [key, pattern] of Object.entries(HEADERS)) {
      const index = header.findIndex((name) => pattern.test(name.trim()));
      if (index >= 0) columns[key] = index;
    }
    // a column the header does not name keeps its usual position, unless another column is there
    const used = new Set(Object.values(columns));
    for (const [key, index] of Object.entries(positions))
      if (!(key in columns) && !used.has(index) && (index >= header.length || !header[index].trim())) columns[key] = index;
  }
  const at = (cells, key) => (columns[key] === undefined ? '' : cells[columns[key]] ?? '');
  return table.map(({ line, cells }) => ({
    line,
    username: at(cells, 'username').trim(),
    password: at(cells, 'password'),
    realName: at(cells, 'realName').trim(),
    groups: at(cells, 'groups').split(/[;；|]/).map((x) => x.trim()).filter(Boolean),
  }));
}
