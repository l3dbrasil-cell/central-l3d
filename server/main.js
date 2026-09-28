import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { Bling } from './bling.js';
import { Sync } from './sync.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function equal(a, b) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function createApp({ store, bling, sync, appUrl = 'http://127.0.0.1:3000', password = '' }) {
  const base = new URL(appUrl), local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (!local && (base.protocol !== 'https:' || password.length < 20)) throw new Error('Produção exige HTTPS e ADMIN_PASSWORD com pelo menos 20 caracteres.');
  const sessions = new Map();
  const cookie = (value) => `central_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${base.protocol === 'https:' ? '; Secure' : ''}`;
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!local) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== base.host) return json(403, { error: 'Host inválido.' });
      const url = new URL(req.url, base);
      if (password) {
        const expected = `Basic ${Buffer.from(`central:${password}`).toString('base64')}`;
        if (!equal(req.headers.authorization || '', expected)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Central L3D", charset="UTF-8"');
          return json(401, { error: 'Entre para acessar a Central L3D.' });
        }
      }
      let sessionId = /(?:^|;\s*)central_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const now = Date.now();
      for (const [id, value] of sessions) if (value.expires < now) sessions.delete(id);
      if (!sessions.has(sessionId)) {
        sessionId = randomBytes(32).toString('hex');
        sessions.set(sessionId, { csrf: randomBytes(32).toString('hex'), expires: now + 12 * 3600000 });
        res.setHeader('Set-Cookie', cookie(sessionId));
      }
      const session = sessions.get(sessionId);
      if (url.pathname === '/api/status' && req.method === 'GET') return json(200, { configured: bling.configured(), connected: bling.connected(), csrf: session.csrf });
      if (url.pathname === '/auth/bling/start' && req.method === 'POST') {
        if (req.headers.origin !== base.origin || !equal(req.headers['x-csrf-token'] || '', session.csrf)) return json(403, { error: 'Reabra a página para conectar.' });
        if (!bling.configured()) return json(503, { error: 'O aplicativo Bling ainda precisa ser configurado no servidor.' });
        session.oauth = { state: randomBytes(32).toString('hex'), expires: now + 10 * 60000 };
        const destination = new URL('https://bling.com.br/Api/v3/oauth/authorize');
        destination.searchParams.set('response_type', 'code');
        destination.searchParams.set('client_id', bling.clientId);
        destination.searchParams.set('state', session.oauth.state);
        return json(200, { url: destination.href });
      }
      if (url.pathname === '/auth/bling/callback' && req.method === 'GET') {
        const oauth = session.oauth;
        delete session.oauth; // Single use, including denial and exchange failure.
        if (!oauth || oauth.expires < now || !equal(url.searchParams.get('state') || '', oauth.state)) return json(400, { error: 'Autorização expirada ou inválida. Volte à Central L3D e conecte novamente.' });
        if (url.searchParams.has('error')) { res.writeHead(303, { Location: '/?authorization=denied' }); return res.end(); }
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) return json(400, { error: 'Código de autorização ausente.' });
        await bling.exchange({ grant_type: 'authorization_code', code });
        // Reauthorization may select another Bling account: discard old business data.
        sync.reset();
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (url.pathname === '/api/sku' && req.method === 'GET') {
        if (!bling.connected()) return json(401, { error: 'Conecte sua conta Bling.' });
        const sku = url.searchParams.get('sku');
        // No uppercase/trim/normalization: the platform SKU is the only business key.
        if (!sku || sku.length > 200 || /[\u0000-\u001f]/.test(sku)) return json(400, { error: 'Informe um SKU válido.' });
        return json(200, await sync.snapshot(sku));
      }
      const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js' };
      if (req.method === 'GET' && files[url.pathname]) {
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        return res.end(readFileSync(resolve(root, files[url.pathname])));
      }
      json(404, { error: 'Não encontrado.' });
    } catch (e) {
      // Never log provider bodies, request URLs/codes, tokens or client secrets.
      json([400, 401, 403, 404, 409, 429, 503].includes(e.status) ? e.status : 502, { error: e.message || 'Falha ao consultar o Bling.' });
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
  const host = process.env.HOST || '127.0.0.1';
  const password = process.env.ADMIN_PASSWORD || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !password) throw new Error('Acesso externo exige ADMIN_PASSWORD.');
  const store = new Store(resolve(process.env.DATA_DIR || 'data'));
  const bling = new Bling(store, { clientId: process.env.BLING_CLIENT_ID, clientSecret: process.env.BLING_CLIENT_SECRET });
  const sync = new Sync(bling, store);
  const server = createApp({ store, bling, sync, appUrl, password });
  let refreshing = false;
  const refresh = async () => { if (refreshing) return; refreshing = true; try { await sync.refresh(); } finally { refreshing = false; } };
  const timer = setInterval(refresh, 5 * 60000);
  server.listen(Number(process.env.PORT || 3000), host, () => { console.log(`Central L3D: ${appUrl}`); refresh(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); });
}
