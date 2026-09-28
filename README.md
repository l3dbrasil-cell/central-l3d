# Central L3D

Dashboard web da L3D para centralizar produtos, SKUs, preços, estoque e performance por marketplace.

Integração Bling API v3/OAuth implementada para leitura de produto, estoque e pedidos por SKU exato, mantendo a dashboard existente. A ativação depende de autorizar a conta e configurar a hospedagem do servidor. Sem dados fictícios nesta versão.

Node.js 24+: `npm test` e `npm start`. Consulte [arquitetura, configuração e limites](docs/integration.md).

Mercado Livre, Shopee e TikTok Shop têm um contrato de adaptadores preparado; conexões e métricas de marketplace ainda não estão ativadas.
