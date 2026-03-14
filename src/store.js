const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor() {
    this.path = path.join(app.getPath('userData'), 'config.json');
    this.data = this._load();
  }
  _load() {
    try { return JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { return {}; }
  }
  get(key) { return this.data[key]; }
  set(key, value) {
    this.data[key] = value;
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

module.exports = Store;
