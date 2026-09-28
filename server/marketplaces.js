// Adapter boundary. Provider-specific OAuth, settlements and Ads APIs can be added
// without changing the Bling SKU or treating Bling's catalogue price as a listing.
// An adapter implements async listingsForSku(exactSku) and returns this contract.
export const pendingMarketplaces = ['Mercado Livre', 'Shopee', 'TikTok Shop'];
export function profitability(listing) {
  const values = ['publishedPrice', 'fee', 'freight', 'tax', 'cost', 'adsPerUnit'].map(k => listing[k]);
  if (values.some(v => typeof v !== 'number' || !Number.isFinite(v)) || values[0] <= 0 || listing.basis !== 'per-unit-BRL') return { profit: null, margin: null };
  const profit = values[0] - values.slice(1).reduce((a, b) => a + b, 0);
  return { profit: Math.round(profit * 100) / 100, margin: profit / values[0] * 100 };
}
export async function marketplaceListings(sku, adapters = []) {
  const result = [];
  for (const adapter of adapters) {
    for (const listing of await adapter.listingsForSku(sku)) {
      if (listing.sku !== sku) continue;
      result.push({ ...listing, ...profitability(listing) });
    }
  }
  return result;
}
