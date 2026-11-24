import { fail } from './http.js';
import { allowedFor } from './contest-time.js';
import { joinedAt } from './participation.js';

// The folder of a contestant in the code export and on LemonServer: "{name}", "{username}", "te{id:3}st", ...
// The local submission folders always use the account name.
export const DEFAULT_FOLDER_FORMAT = '{name}';
// Contests of earlier releases keep the folders their exports and LemonServer contests already use.
export const LEGACY_FOLDER_FORMAT = '{username}';
const MAX = 64;
const INVALID = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const collator = new Intl.Collator('zh-CN', { numeric: true });
const chars = text => [...text];

export function parseFolderFormat(value) {
  const format = typeof value === 'string' ? value.trim() : '';
  if (!format) fail(400, '请填写文件夹名格式');
  if (chars(format).length > MAX) fail(400, `文件夹名格式最多 ${MAX} 个字符`);
  if (/[. ]$/.test(format)) fail(400, '文件夹名格式不能以点或空格结尾');
  const parts = [];
  for (const [, field, text] of format.matchAll(/\{([^{}]*)\}|([^{}]+)|[{}]/g)) {
    if (text !== undefined) {
      if (INVALID.test(text)) fail(400, '文件夹名格式不能包含 \\ / : * ? " < > | 等字符');
      parts.push({ text });
      continue;
    }
    if (field === undefined) fail(400, '“{”和“}”须成对使用，如 {id:3}');
    const match = /^(name|username|id)(?::(\d{1,2}))?$/.exec(field);
    if (!match) fail(400, `不支持 {${field}}，可用 {name}、{username}、{id} 或 {id:3}`);
    if (match[2] !== undefined && match[1] !== 'id') fail(400, `{${match[1]}} 不能指定位数`);
    const width = match[2] === undefined ? 0 : Number(match[2]);
    if (match[2] !== undefined && (width < 1 || width > 9)) fail(400, '编号位数应为 1–9');
    parts.push({ field: match[1], width });
  }
  if (!parts.some(part => part.field)) fail(400, '格式须包含 {name}、{username} 或 {id}');
  return { format, parts };
}

// The largest number a format can show: {id:3} -> 999 (Infinity without a fixed width).
const capacityOf = parts => Math.min(...parts.filter(part => part.field === 'id' && part.width).map(part => 10 ** part.width - 1));
const highestNumber = numbers => Object.values(numbers).reduce((max, number) => Math.max(max, number), 0);

export function renderFolderName(parts, user, number) {
  const clean = value => String(value ?? '').replace(new RegExp(INVALID.source, 'g'), '_');
  let name = parts.map(part => part.text ?? (part.field === 'id' ? String(number).padStart(part.width, '0')
    : clean(part.field === 'name' ? user.realName || user.username : user.username))).join('');
  name = chars(name.trim()).slice(0, MAX).join('').replace(/[. ]+$/, '');
  if (!name) name = user.username;
  return RESERVED.test(name) ? name + '_' : name;
}

const suffixed = (name, n) => {
  const tail = '_' + n;
  return chars(name).slice(0, MAX - tail.length).join('').replace(/[. ]+$/, '') + tail;
};

// Contestants in the order they entered, so that the names and numbers of earlier ones never change.
export function folderParticipants(data, contest) {
  return data.users.filter(user => user.role !== 'admin')
    .map(user => ({ user, at: joinedAt(data, contest, user.id) })).filter(item => item.at)
    .sort((a, b) => a.at - b.at || collator.compare(a.user.username, b.user.username)).map(item => item.user);
}

// user id -> folder name. Numbers of {id} are given in the order of entry and kept in contest.folderNumbers
// (the mapping between numbers and accounts). Equal names (ignoring case) get "_2", "_3", ...
export function contestFolders(data, contest) {
  const { parts } = parseFolderFormat(contest.folderFormat ?? LEGACY_FOLDER_FORMAT);
  const capacity = capacityOf(parts), numbered = parts.some(part => part.field === 'id');
  const numbers = { ...(contest.folderNumbers || {}) };
  let next = highestNumber(numbers) + 1, changed = false;
  const names = new Map(), errors = new Map(), taken = new Set();
  for (const user of folderParticipants(data, contest)) {
    const id = String(user.id);
    if (numbered && numbers[id] === undefined && next <= capacity) { numbers[id] = next++; changed = true; }
    if (numbered && !(numbers[id] <= capacity)) { errors.set(id, `编号位数不足（最多 ${capacity} 个编号）`); continue; }
    const base = renderFolderName(parts, user, numbers[id]);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = suffixed(base, n);
    taken.add(name.toLowerCase());
    names.set(id, name);
  }
  if (changed) contest.folderNumbers = numbers;
  return { names, errors, changed };
}

// Validates a format for saving: its numbers must suffice for everyone who may take part.
export function checkFolderFormat(data, contest, value, groups) {
  const { format, parts } = parseFolderFormat(value);
  const capacity = capacityOf(parts);
  if (capacity === Infinity) return format;
  const numbers = contest.folderNumbers || {}, highest = highestNumber(numbers);
  const people = data.users.filter(user => user.role !== 'admin' && (allowedFor({ groups }, user) || joinedAt(data, contest, user.id)));
  if (highest > capacity) fail(400, `已分配的编号最大为 ${highest}，至少需要 ${String(highest).length} 位`);
  if (highest + people.filter(user => numbers[user.id] === undefined).length > capacity)
    fail(400, `编号位数不足：最多 ${capacity} 个编号，本场比赛可参赛 ${people.length} 人，请增加位数`);
  return format;
}

export function previewFolders(data, contest, value, groups) {
  let parts;
  try { ({ parts } = parseFolderFormat(value)); } catch (error) { return { examples: [], error: error.message }; }
  let error = null;
  try { checkFolderFormat(data, contest, value, groups); } catch (failure) { error = failure.message; }
  const joined = contest.id ? folderParticipants(data, contest) : [];
  const eligible = data.users.filter(user => user.role !== 'admin' && allowedFor({ groups }, user))
    .sort((a, b) => collator.compare(a.username, b.username));
  const sample = [...joined, ...eligible.filter(user => !joined.includes(user))].slice(0, 3);
  if (!sample.length) sample.push({ username: 'SC-00001', realName: '张三' }, { username: 'SC-00002', realName: '李四' });
  const numbers = contest.folderNumbers || {};
  let next = highestNumber(numbers) + 1;
  const capacity = capacityOf(parts);
  return { examples: sample.map(user => renderFolderName(parts, user, numbers[user.id] ?? next++)),
    capacity: capacity === Infinity ? null : capacity, eligible: eligible.length, error };
}

export function migrateFolderFormats(ctx) {
  for (const contest of ctx.data.contests) {
    if (typeof contest.folderFormat === 'string') {
      try { parseFolderFormat(contest.folderFormat); continue; } catch { ctx.log('invalid folder name format reset:', contest.name); }
    }
    contest.folderFormat = LEGACY_FOLDER_FORMAT;
    // LemonServer folders made by earlier releases are named after the accounts
    if (!contest.lemon?.contest || !ctx.data.lemonState[contest.id]) continue;
    const remote = ctx.lemon.remoteFolders(contest);
    for (const user of folderParticipants(ctx.data, contest)) remote[user.id] ??= user.username;
  }
}
