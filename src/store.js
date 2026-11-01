import fs from 'node:fs';
import path from 'node:path';

// All of CodeHub's state lives in one JSON file, written atomically (a few hundred users and a
// handful of contests fit comfortably in memory).
export class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.data = null;
  }

  load(defaults) {
    let data = {};
    if (fs.existsSync(this.file)) {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
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
      this.flush();
    }, 150);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
