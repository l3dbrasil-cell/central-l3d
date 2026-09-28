import { marketplaceListings, pendingMarketplaces } from './marketplaces.js';

export const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function period(now = new Date()) {
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(`${end}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { start: start.toISOString().slice(0, 10), end };
}
export function aggregate(sku, orders) {
  let units = 0, itemValue = 0, count = 0;
  const byStatus = new Map();
  for (const order of orders) {
    const items = order.items.filter(item => item.sku === sku);
    if (!items.length) continue;
    count++;
    const key = String(order.statusId ?? 'desconhecida');
    const group = byStatus.get(key) || { statusId: order.statusId, orders: 0, units: 0, itemValue: 0 };
    group.orders++;
    for (const item of items) {
      if (item.quantity === null || item.unitValue === null) throw new Error('Pedido com valor ou quantidade ausente; total não calculado.');
      units += item.quantity;
      itemValue += item.quantity * item.unitValue;
      group.units += item.quantity;
      group.itemValue += item.quantity * item.unitValue;
    }
    byStatus.set(key, group);
  }
  return { orders: count, units, itemValue: Math.round(itemValue * 100) / 100, byStatus: [...byStatus.values()],
    basis: 'Todos os estados de pedido, inclusive cancelados e abertos. Valor dos itens antes de descontos gerais, frete e impostos; não é faturamento realizado.' };
}
export class Sync {
  constructor(bling, store, adapters = []) { Object.assign(this, { bling, store, adapters }); this.products = new Map(); this.ordersJob = null; this.epoch = 0; }
  reset() { this.epoch++; this.store.db.exec("DELETE FROM kv WHERE key <> 'tokens'"); }
  async orders() {
    const dates = period(), cached = this.store.get('orders');
    if (cached?.period.end === dates.end && Date.now() - cached.at < 15 * 60000) return cached;
    const failed = this.store.get('ordersError');
    if (failed && Date.now() - failed.at < 60000) throw new Error(failed.message);
    if (!this.ordersJob) this.ordersJob = this.loadOrders(dates).then(result => { this.store.delete('ordersError'); return result; }).finally(() => { this.ordersJob = null; });
    return this.ordersJob;
  }
  async loadOrders(dates) {
    const epoch = this.epoch;
    const summaries = await this.bling.list('/pedidos/vendas', { dataInicial: dates.start, dataFinal: dates.end });
    const unique = new Map(summaries.map(o => [String(o.id), o]));
    const orders = [];
    for (const summary of unique.values()) {
      const o = await this.bling.get(`/pedidos/vendas/${encodeURIComponent(summary.id)}`);
      if (!Array.isArray(o.itens) || o.itens.some(i => typeof i.codigo !== 'string' || !i.codigo)) throw new Error('Pedido com SKU ausente; totais indisponíveis para evitar omissões.');
      if (o.data < dates.start || o.data > dates.end) continue;
      // Persist only operational fields; no customer/address/payment data.
      orders.push({ id: o.id, date: o.data, statusId: o.situacao?.id ?? null, storeId: o.loja?.id ?? null,
        items: o.itens.map(i => ({ sku: i.codigo, quantity: number(i.quantidade), unitValue: number(i.valor) })) });
    }
    const result = { at: Date.now(), period: dates, orders };
    if (epoch !== this.epoch) throw new Error('Conta alterada; nova sincronização necessária.');
    this.store.set('orders', result); // Replace atomically only after every page/detail succeeds.
    return result;
  }
  product(sku) {
    if (!this.products.has(sku)) this.products.set(sku, this.loadProduct(sku).finally(() => this.products.delete(sku)));
    return this.products.get(sku);
  }
  async loadProduct(sku) {
    const epoch = this.epoch;
    const matches = (await this.bling.list('/produtos', { 'codigos[]': sku, criterio: 5, tipo: 'T' })).filter(p => p.codigo === sku);
    if (!matches.length) throw Object.assign(new Error('SKU não encontrado no Bling. Confira o código exato.'), { status: 404 });
    if (matches.length !== 1) throw Object.assign(new Error('SKU duplicado no Bling. Os produtos não foram somados.'), { status: 409 });
    const p = await this.bling.get(`/produtos/${encodeURIComponent(matches[0].id)}`);
    if (p.codigo !== sku) throw new Error('O código do produto mudou durante a consulta. Consulte novamente.');
    const errors = [];
    let stock = null;
    try {
      const balances = await this.bling.get('/estoques/saldos', { 'idsProdutos[]': p.id });
      const b = balances.find(b => String(b.produto?.id) === String(p.id));
      stock = b ? { physical: number(b.saldoFisicoTotal), available: number(b.saldoVirtualTotal) } : null;
      if (!stock) errors.push('Saldo de estoque não retornado pelo Bling.');
    } catch (e) { errors.push(e.message); }
    const result = { at: Date.now(), product: { id: p.id, sku: p.codigo, name: p.nome, ean: p.gtin || null,
      cost: number(p.fornecedor?.precoCusto), cataloguePrice: number(p.preco), unit: p.unidade || null, status: p.situacao,
      costSource: 'Bling: fornecedor.precoCusto (cadastro atual)' }, stock, errors };
    if (epoch !== this.epoch) throw new Error('Conta alterada; nova sincronização necessária.');
    this.store.set(`product:${sku}`, result);
    this.store.delete(`error:${sku}`);
    return result;
  }
  watch(sku) {
    const watched = this.store.get('watched') || [];
    this.store.set('watched', [sku, ...watched.filter(s => s !== sku)].slice(0, 100));
    const cached = this.store.get(`product:${sku}`);
    const failed = this.store.get(`error:${sku}`);
    if ((!cached || Date.now() - cached.at > 5 * 60000) && (!failed || Date.now() - failed.at >= 60000)) this.product(sku).catch(e => this.store.set(`error:${sku}`, { message: e.message, status: e.status || 502, at: Date.now() }));
    this.orders().catch(e => this.store.set('ordersError', { message: e.message, at: Date.now() }));
  }
  async snapshot(sku) {
    this.watch(sku);
    const product = this.store.get(`product:${sku}`), orders = this.store.get('orders');
    const err = this.store.get(`error:${sku}`);
    if (!product && err && !this.products.has(sku)) throw Object.assign(new Error(err.message), { status: err.status });
    const dates = period();
    const validOrders = orders?.period.end === dates.end;
    return { state: product ? 'ready' : 'syncing', ...(product || {}),
      stale: Boolean(product && Date.now() - product.at > 5 * 60000),
      errors: [...(product?.errors || []), ...(err ? [err.message] : []), ...(this.store.get('ordersError') ? [this.store.get('ordersError').message] : [])],
      summary: validOrders ? aggregate(sku, orders.orders) : null, period: dates,
      ordersUpdatedAt: validOrders ? orders.at : null, ordersSyncing: Boolean(this.ordersJob),
      listings: await marketplaceListings(sku, this.adapters), pendingMarketplaces };
  }
  async refresh() {
    if (!this.bling.connected()) return;
    try { await this.orders(); this.store.delete('ordersError'); } catch (e) { this.store.set('ordersError', { message: e.message, at: Date.now() }); }
    for (const sku of this.store.get('watched') || []) {
      try { await this.product(sku); this.store.delete(`error:${sku}`); } catch (e) { this.store.set(`error:${sku}`, { message: e.message, status: e.status || 502, at: Date.now() }); }
    }
  }
}
