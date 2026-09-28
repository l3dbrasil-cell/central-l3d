const $ = id => document.getElementById(id);
const money = value => typeof value === 'number' ? value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';
const amount = value => typeof value === 'number' ? value.toLocaleString('pt-BR') : '—';
let csrf, currentSku = null, generation = 0, timer, latest;
async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Esta publicação ainda aguarda a ativação do servidor de integração.');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Falha ao consultar os dados.');
  return body;
}
function text(id, value) { $(id).textContent = value; }
function cell(parent, value, tag = 'td') { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; }
function clear() {
  latest = null;
  for (const id of ['sku', 'units', 'revenue', 'stock', 'channelsCount']) text(id, '—');
  for (const id of ['listings', 'compare', 'ordersStatus', 'productDetails']) $(id).replaceChildren();
  $('cost').value = '';
  text('name', 'Aguardando produto.'); text('basis', 'Aguardando dados reais.');
}
function render(data) {
  latest = data;
  if (data.product) {
    const p = data.product;
    text('sku', p.sku); text('name', `${p.name} · EAN ${p.ean || '—'}`);
    $('cost').value = p.cost === null ? '' : money(p.cost);
    text('productDetails', `Preço de cadastro: ${money(p.cataloguePrice)} · Estoque físico: ${amount(data.stock?.physical)} · ${p.costSource}`);
    text('stock', amount(data.stock?.available));
  }
  text('units', amount(data.summary?.units)); text('revenue', money(data.summary?.itemValue));
  text('basis', data.summary ? `${data.period.start} a ${data.period.end} · ${data.summary.basis}` : 'Sincronizando todos os pedidos dos últimos 30 dias. Os totais aparecerão ao concluir.');
  text('ordersStatus', data.summary ? data.summary.byStatus.map(g => `Situação Bling ${g.statusId ?? 'desconhecida'}: ${g.orders} pedidos, ${amount(g.units)} unidades`).join(' · ') : '');
  $('listings').replaceChildren(); $('compare').replaceChildren();
  text('channelsCount', data.listings.length ? amount(new Set(data.listings.map(l => l.marketplace)).size) : '—');
  const pending = data.pendingMarketplaces.filter(name => !data.listings.some(l => l.marketplace === name)).map(marketplace => ({ marketplace }));
  for (const listing of [...data.listings, ...pending]) {
    const card = document.createElement('div'); card.className = 'channel';
    const top = document.createElement('div'); top.className = 'ctop';
    cell(top, listing.marketplace, 'strong'); cell(top, money(listing.publishedPrice), 'strong');
    if (!listing.listingId) cell(top, 'Aguardando conexão', 'span');
    try { const url = new URL(listing.url); if (url.protocol === 'https:') { const a = cell(top, 'ABRIR ANÚNCIO ↗', 'a'); a.href = url.href; a.rel = 'noopener noreferrer'; a.target = '_blank'; a.className = 'open'; } } catch {}
    card.append(top);
    const numbers = document.createElement('div'); numbers.className = 'numbers';
    for (const [label, key] of [['Taxa', 'fee'], ['Frete L3D', 'freight'], ['Impostos', 'tax'], ['Custo', 'cost'], ['Ads/venda', 'adsPerUnit'], ['Lucro/un.', 'profit']]) {
      const n = document.createElement('div'); n.className = 'n'; cell(n, label, 'span'); cell(n, money(listing[key]), 'b'); numbers.append(n);
    }
    const margin = typeof listing.margin === 'number' ? `${listing.margin.toFixed(1)}%` : '—';
    const n = document.createElement('div'); n.className = 'n'; cell(n, 'Margem', 'span'); cell(n, margin, 'b'); numbers.append(n);
    card.append(numbers);
    const perf = document.createElement('div'); perf.className = 'perf';
    for (const [label, value] of [['Vendas 30d', amount(listing.sales)], ['Faturamento', money(listing.revenue)], ['Ads', money(listing.adSpend)], ['ROAS', typeof listing.roas === 'number' ? `${listing.roas.toFixed(1)}x` : '—']]) {
      const n = document.createElement('div'); n.className = 'n'; cell(n, label, 'span'); cell(n, value, 'b'); perf.append(n);
    }
    card.append(perf); $('listings').append(card);
    const row = document.createElement('tr');
    const reading = listing.margin == null ? 'Dados incompletos' : listing.margin >= Number($('target').value) ? 'Acima da meta' : 'Abaixo da meta';
    for (const value of [listing.marketplace, money(listing.publishedPrice), money(listing.profit), margin, reading]) cell(row, value);
    $('compare').append(row);
  }
  const updated = data.at ? new Date(data.at).toLocaleString('pt-BR') : 'aguardando';
  const ordersUpdated = data.ordersUpdatedAt ? ` · Pedidos atualizados em ${new Date(data.ordersUpdatedAt).toLocaleString('pt-BR')}` : '';
  text('status', data.state === 'syncing' ? 'Consultando produto no Bling…' : `Bling · Produto atualizado em ${updated}${ordersUpdated}${data.stale ? ' · Dados anteriores; atualização pendente' : ''}${data.ordersSyncing ? ' · Atualizando pedidos' : ''}${data.errors.length ? ' · ' + data.errors.join(' · ') : ''}`);
}
async function poll(version) {
  try {
    const result = await api(`/api/sku?sku=${encodeURIComponent(currentSku)}`);
    if (version !== generation) return;
    render(result);
    timer = setTimeout(() => poll(version), result.state === 'syncing' || result.ordersSyncing ? 5000 : 60000);
  } catch (e) { if (version === generation) { text('status', e.message); timer = setTimeout(() => poll(version), 60000); } }
}
$('search').addEventListener('submit', e => { e.preventDefault(); currentSku = $('q').value; clearTimeout(timer); clear(); poll(++generation); });
$('target').addEventListener('input', () => { if (latest) render(latest); });
$('connect').addEventListener('click', async () => {
  try { const result = await api('/auth/bling/start', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }); location.assign(result.url); }
  catch (e) { text('status', e.message); }
});
async function init() {
  try {
    const status = await api('/api/status'); csrf = status.csrf;
    $('connect').hidden = !status.configured;
    $('connect').textContent = status.connected ? 'RECONECTAR BLING' : 'CONECTAR BLING';
    text('status', status.connected ? 'Bling conectado. Consulte seu SKU exato.' : status.configured ? 'Autorize a leitura dos seus dados no Bling.' : 'Integração preparada. Aguardando configuração do aplicativo Bling no servidor.');
  } catch (e) { text('status', e.message); }
}
init();
