import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function durableWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      let directory;
      try { directory = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(directory); }
      catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
      finally { if (directory !== undefined) fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// All of CodeHub's state lives in one JSON file, written atomically (a few hundred users and a
// handful of contests fit comfortably in memory).
export class Store {
  constructor(file, onError = console.error) {
    this.file = file;
    this.timer = null;
    this.data = null;
    this.lastGood = null;
    this.onError = onError;
    this.lastError = null;
  }

  load(defaults) {
    let data = {};
    if (fs.existsSync(this.file) || fs.existsSync(this.file + '.bak')) {
      let recovered = false;
      for (const file of [this.file, this.file + '.bak']) {
        try {
          const text = fs.readFileSync(file, 'utf8');
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid configuration object');
          for (const key of ['users', 'groups', 'contests']) if (key in parsed && !Array.isArray(parsed[key])) throw Error('Invalid ' + key);
          data = parsed; this.lastGood = text; recovered = file !== this.file;
          break;
        } catch (error) { if (file.endsWith('.bak')) throw new Error('配置和备份均不可读取，请保留原文件后恢复：' + error.message); }
      }
      if (recovered) {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.corrupt-' + randomUUID());
        this.onError('主配置损坏，已从 codehub.json.bak 恢复；损坏文件已保留。');
      }
    }
    this.data = { ...structuredClone(defaults), ...data };
    for (const [k, v] of Object.entries(defaults)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && this.data[k] && typeof this.data[k] === 'object')
        this.data[k] = { ...structuredClone(v), ...this.data[k] };
    }
    return this.data;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.flush(); }
      catch (error) { this.lastError = error.message; this.onError('保存失败，将重试：' + error.message); this.timer = setTimeout(() => { this.timer = null; this.save(); }, 5000); this.timer.unref?.(); }
    }, 150);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const text = JSON.stringify(this.data, null, 1);
      if (this.lastGood !== null && text !== this.lastGood) durableWrite(this.file + '.bak', this.lastGood);
      durableWrite(this.file, text);
      this.lastGood = text;
      this.lastError = null;
    } catch (error) { this.lastError = error.message; throw error; }
  }
}
