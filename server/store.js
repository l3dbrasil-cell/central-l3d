import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// One service instance per database. Keep this directory on a private persistent disk.
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'key');
    try { this.key = readFileSync(keyPath); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.key = randomBytes(32);
      writeFileSync(keyPath, this.key, { mode: 0o600, flag: 'wx' });
    }
    this.db = new DatabaseSync(join(directory, 'central.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  get(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  delete(key) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  secret(key, value) {
    if (arguments.length === 1) {
      const box = this.get(key);
      if (!box) return null;
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
      cipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.data, 'base64')), cipher.final()]).toString());
    }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    this.set(key, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  close() { this.db.close(); }
}
