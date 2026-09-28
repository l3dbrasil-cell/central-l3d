import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Bling } from '../server/bling.js';
import { Sync, aggregate, period } from '../server/sync.js';
import { profitability, marketplaceListings } from '../server/marketplaces.js';
import { createApp } from '../server/main.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'central-test-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
test('tokens encrypted at rest and survive restart', t => {
  const { store, dir } = fixture(t);
  store.secret('tokens', { access: 'sensitive-access', refresh: 'sensitive-refresh' });
  assert.equal(store.secret('tokens').access, 'sensitive-access');
  assert.ok(!JSON.stringify(store.get('tokens')).includes('sensitive'));
  const second = new Store(dir);
  assert.equal(second.secret('tokens').refresh, 'sensitive-refresh'); second.close();
});
test('OAuth uses Basic, form body, rotating refresh and a single refresh for concurrent calls', async t => {
  const { store } = fixture(t); let refreshes = 0;
  store.secret('tokens', { access: 'expired', refresh: 'previous', expires: 0 });
  const api = new Bling(store, { clientId: 'id', clientSecret: 'secret', delay: async () => {}, fetcher: async (url, options) => {
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'previous'); refreshes++;
    return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
  } });
  assert.deepEqual(await Promise.all([api.token(), api.token()]), ['new', 'new']);
  assert.equal(refreshes, 1); assert.equal(store.secret('tokens').refresh, 'rotated');
});
test('401 refresh, 429 retry and query encoding preserve exact SKU', async t => {
  const { store } = fixture(t); let calls = 0;
  store.secret('tokens', { access: 'old', refresh: 'r', expires: Date.now() + 3600000 });
  const api = new Bling(store, { clientId: 'id', clientSecret: 's', delay: async () => {}, fetcher: async url => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
    assert.equal(new URL(url).searchParams.get('codigos[]'), '00a /+ç');
    calls++;
    return calls === 1 ? new Response('', { status: 401 }) : calls === 2 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({ data: [{ codigo: '00a /+ç' }] });
  } });
  assert.equal((await api.get('/produtos', { 'codigos[]': '00a /+ç' }))[0].codigo, '00a /+ç');
  assert.equal(calls, 3);
});
test('pagination includes final page and aborts on an incomplete page', async t => {
  const { store } = fixture(t); const api = new Bling(store, {}); let calls = 0;
  api.get = async (_path, query) => { calls++; return query.pagina === 1 ? Array(100).fill({}) : [{ id: 101 }]; };
  assert.equal((await api.list('/produtos')).length, 101); assert.equal(calls, 2);
  api.get = async () => ({ data: [] }); await assert.rejects(api.list('/produtos'), /Paginação/);
});
test('exact matching: no uppercase, no new SKU; duplicate codes blocked', async t => {
  const { store } = fixture(t);
  const provider = { list: async () => [{ id: 1, codigo: '001a' }, { id: 2, codigo: '001A' }], get: async path => path.startsWith('/produtos/') ? { id: 1, codigo: '001a', nome: 'Produto', fornecedor: { precoCusto: 0 } } : [{ produto: { id: 1 }, saldoFisicoTotal: 2, saldoVirtualTotal: 0 }] };
  const sync = new Sync(provider, store);
  const data = await sync.product('001a'); assert.equal(data.product.sku, '001a'); assert.equal(data.product.cost, 0); assert.equal(data.stock.available, 0);
  await assert.rejects(sync.product('001'), /não encontrado/);
  provider.list = async () => [{ id: 1, codigo: '001a' }, { id: 2, codigo: '001a' }];
  await assert.rejects(sync.product('001a'), /duplicado/);
});
test('failed order sync preserves old snapshot and strips customer fields', async t => {
  const { store } = fixture(t); store.set('orders', { old: true });
  const provider = { list: async () => [{ id: 1 }, { id: 2 }], get: async () => { throw new Error('temporary'); } };
  const sync = new Sync(provider, store);
  await assert.rejects(sync.loadOrders(period()), /temporary/); assert.deepEqual(store.get('orders'), { old: true });
  provider.get = async () => ({ id: 1, data: period().end, contato: { nome: 'Private' }, itens: [{ codigo: 'a', quantidade: 2, valor: 5 }] });
  await sync.loadOrders(period()); assert.ok(!JSON.stringify(store.get('orders')).includes('Private'));
});
test('reset prevents an in-flight previous-account result entering the cache', async t => {
  const { store } = fixture(t); let release;
  const provider = { list: () => new Promise(r => { release = r; }) };
  const sync = new Sync(provider, store); const job = sync.loadOrders(period()); sync.reset(); release([]);
  await assert.rejects(job, /Conta alterada/); assert.equal(store.get('orders'), null);
});
test('all-state order metrics explicitly labelled; missing amounts are not zero', () => {
  const result = aggregate('001a', [{ statusId: 9, items: [{ sku: '001a', quantity: 2, unitValue: 4.9 }, { sku: '001A', quantity: 100, unitValue: 100 }] }]);
  assert.equal(result.units, 2); assert.equal(result.itemValue, 9.8); assert.match(result.basis, /cancelados/);
  assert.throws(() => aggregate('a', [{ items: [{ sku: 'a', quantity: null, unitValue: 10 }] }]), /ausente/);
  assert.deepEqual(period(new Date('2026-09-28T01:00:00Z')), { start: '2026-08-29', end: '2026-09-27' });
});
test('no profit from missing costs; adapters cannot silently change SKU', async () => {
  const listing = { sku: '001a', basis: 'per-unit-BRL', publishedPrice: 100, fee: 10, freight: 0, tax: 5, cost: 30, adsPerUnit: 5 };
  assert.deepEqual(profitability(listing), { profit: 50, margin: 50 });
  assert.equal(profitability({ ...listing, tax: null }).profit, null);
  assert.equal(profitability({ ...listing, cost: undefined }).profit, null);
  assert.equal((await marketplaceListings('001A', [{ listingsForSku: async () => [listing] }])).length, 0);
});
test('HTTP: auth, CSRF, state binding, replay, no secret/static-file leakage', async t => {
  const { store } = fixture(t); let exchanged = 0;
  const bling = { configured: () => true, connected: () => false, clientId: 'public-client', exchange: async () => { exchanged++; } };
  const app = createApp({ store, bling, sync: { reset: () => {} }, appUrl: 'http://127.0.0.1:31001', password: 'private-password' });
  await new Promise(r => app.listen(31001, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const auth = `Basic ${Buffer.from('central:private-password').toString('base64')}`;
  const headers = { Host: '127.0.0.1:31001', Authorization: auth };
  assert.equal((await fetch(base + '/api/status', { headers: { Host: headers.Host } })).status, 401);
  const response = await fetch(base + '/api/status', { headers });
  const status = await response.json(); headers.Cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/auth/bling/start', { method: 'POST', headers })).status, 403);
  const start = await fetch(base + '/auth/bling/start', { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:31001', 'X-CSRF-Token': status.csrf } });
  const url = new URL((await start.json()).url);
  const callback = `/auth/bling/callback?state=${url.searchParams.get('state')}&code=secret-code`;
  assert.equal((await fetch(base + callback, { headers, redirect: 'manual' })).status, 303);
  assert.equal((await fetch(base + callback, { headers, redirect: 'manual' })).status, 400); assert.equal(exchanged, 1);
  for (const path of ['/.env', '/data/key', '/server/store.js']) assert.equal((await fetch(base + path, { headers })).status, 404);
  assert.equal((await fetch(base + '/api/sku?sku=a', { headers })).status, 401);
  assert.throws(() => createApp({ appUrl: 'https://central.example', password: '' }), /Produção/);
});
test('dashboard preserves styling and contains no demo metrics or inline scripts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('grid-template-columns:220px 1fr')); assert.ok(!html.includes('KITBRUTUSPRO'));
  assert.ok(!html.includes('DEMO-')); assert.ok(!html.includes('onclick='));
});
