import { setTimeout as sleep } from 'node:timers/promises';

export class BlingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class Bling {
  constructor(store, { clientId, clientSecret, fetcher = fetch, delay = sleep }) {
    Object.assign(this, { store, clientId, clientSecret, fetcher, delay });
    this.queue = Promise.resolve();
    this.refreshing = null;
  }
  configured() { return Boolean(this.clientId && this.clientSecret); }
  connected() { return Boolean(this.store.secret('tokens')); }
  async exchange(parameters) {
    const r = await this.fetcher('https://bling.com.br/Api/v3/oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(parameters).toString()
    });
    if (!r.ok) {
      if (parameters.grant_type === 'refresh_token' && [400, 401].includes(r.status)) this.store.delete('tokens');
      throw new BlingError(r.status, 'Não foi possível autorizar o Bling. Conecte novamente.');
    }
    const token = await r.json();
    if (!token.access_token || !token.refresh_token || !(Number(token.expires_in) > 0)) throw new Error('Resposta OAuth inválida.');
    this.store.secret('tokens', { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + Number(token.expires_in) * 1000 });
  }
  async token(force = false) {
    let saved = this.store.secret('tokens');
    if (!saved) throw new BlingError(401, 'Conecte sua conta Bling.');
    if (force || saved.expires < Date.now() + 120000) {
      if (!this.refreshing) this.refreshing = this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh }).finally(() => { this.refreshing = null; });
      await this.refreshing;
      saved = this.store.secret('tokens');
    }
    return saved.access;
  }
  get(path, params = {}) {
    const run = () => this.request(path, params);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
  async request(path, params) {
    const url = new URL(`https://api.bling.com.br/Api/v3${path}`);
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
    }
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const day = new Date().toISOString().slice(0, 10);
      const usage = this.store.get('apiUsage');
      const count = usage?.day === day ? usage.count : 0;
      if (count >= 100000) throw new BlingError(429, 'Pausa preventiva no limite diário de consultas. Dados anteriores preservados.');
      this.store.set('apiUsage', { day, count: count + 1 });
      await this.delay(400); // Global queue: below Bling's 3 requests/second.
      const r = await this.fetcher(url, { headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 401 && !refreshed) { await this.token(true); refreshed = true; continue; }
      if (r.status === 429 || r.status >= 500) {
        const header = r.headers.get('retry-after');
        const retry = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 1000 * 2 ** attempt;
        if (attempt < 4) { await this.delay(Math.min(120000, Math.max(1000, retry || 1000))); continue; }
      }
      if (!r.ok) throw new BlingError(r.status, r.status === 403 ? 'Bling: permissão de leitura ausente para este recurso.' : `Bling indisponível (HTTP ${r.status}).`);
      const payload = await r.json();
      if (!Object.hasOwn(payload, 'data')) throw new Error('Resposta inválida do Bling.');
      return payload.data;
    }
    throw new Error('Limite de tentativas do Bling atingido.');
  }
  async list(path, params = {}) {
    const rows = [];
    for (let pagina = 1; pagina <= 2000; pagina++) {
      const page = await this.get(path, { ...params, pagina, limite: 100 });
      if (!Array.isArray(page)) throw new Error('Paginação inválida do Bling.');
      rows.push(...page);
      if (page.length < 100) return rows;
    }
    throw new Error('Consulta excedeu o limite de páginas; nenhum total parcial foi publicado.');
  }
}
