# Central L3D — integração

## Estado da entrega

Código implementado, com testes automatizados usando respostas simuladas. A conta real ainda não foi autorizada; a integração não está ativada na publicação. A tela e o CSS existentes foram preservados e os dados DEMO removidos desta versão. Não há escrita na API de produtos/pedidos nem criação de SKU.

## Execução

Node.js 24 ou superior, sem dependências externas. `npm test` valida a integração e `npm start` inicia o servidor. Variáveis em `.env.example`. Desenvolvimento usa apenas `127.0.0.1:3000`. Configure no aplicativo Bling o callback exato `APP_URL/auth/bling/callback`. O Bling usa o redirect cadastrado e ignora overrides enviados no authorize.

Uma instância Node mantém SQLite e a chave de criptografia em `DATA_DIR`, que deve ser um volume persistente privado. Faça backup de ambos juntos, com acesso restrito. Em Windows, restrinja o diretório ao usuário do serviço por ACL; o modo Unix não substitui ACLs. Não hospede o banco/chave em GitHub Pages ou no repositório. A chave local protege contra a exposição isolada do banco, não contra alguém que acessa ambos os arquivos.

Produção precisa de HTTPS terminado no proxy, `APP_URL` com a origem pública exata, `HOST=0.0.0.0` e `ADMIN_PASSWORD` aleatória de pelo menos 20 caracteres. O proxy deve preservar o Host e isolar a porta HTTP interna. Login da dashboard: usuário `central`, senha do servidor. Não habilitar cache no proxy. O Dockerfile executa como usuário sem privilégios; preparar permissões do volume para UID 1000.

GitHub Pages não executa esse backend. A publicação atual permanece como está até existir hospedagem privada persistente e um aplicativo Bling autorizado. Não colocar tokens no JavaScript nem apontar a página pública para dados sem autenticação. Servir a mesma dashboard pela origem HTTPS do backend evita CORS e credenciais compartilhadas com páginas públicas. Depois de validar, o Pages pode encaminhar à origem protegida.

## OAuth e permissões

Aplicativo privado na Central de Extensões / Área do Integrador. Solicitar somente leitura de Produtos, Estoques e Pedidos de Venda. O servidor recebe `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` via ambiente; o usuário final apenas clica Conectar Bling e autoriza. State aleatório de uso único é vinculado à sessão e expira em 10 minutos. POST de início exige mesma origem e token CSRF. Tokens são trocados exclusivamente no servidor, criptografados com AES-GCM, renovados em fila única e persistidos após cada rotação. Negação/replay/expiração não autoriza o acesso. Mudança de conta limpa os caches e impede resultados antigos em voo de repovoá-los.

## Dados e atualização

- `codigo` é o SKU original, sem trim, uppercase, prefixo ou ID interno. IDs Bling são apenas referências do provedor. Zeros à esquerda, acentos e diferenças de caixa são preservados. Duplicatas não são mescladas.
- Produtos: código, nome, GTIN, unidade, situação, preço de cadastro e custo cadastrado do fornecedor. Preço do catálogo não é preço publicado e custo atual não é custo histórico realizado.
- Estoque: físico e virtual total, sem somar depósitos novamente.
- Pedidos: todas as páginas dos últimos 30 dias corridos no calendário de São Paulo; todos os detalhes antes de publicar um snapshot. Guarda apenas data, situação, loja, código do item, quantidade e valor; descarta dados de clientes. Unidades e valor dos itens incluem todos os estados, inclusive abertos/cancelados, com aviso visível e separação por situação. Não afirma que sejam vendas liquidadas/faturamento. Não aplica desconto do item novamente a `valor`, que já é unitário após desconto; não rateia desconto geral, impostos ou frete sem regras verificadas.
- Produtos consultados são acompanhados automaticamente (100 mais recentes). Produtos/estoque a cada 5 minutos; pedidos a cada 15 minutos, com cache global. A primeira consulta pode demorar em contas grandes. A tela consulta o andamento; não mantém uma única requisição HTTP longa.
- Uma fila global respeita menos de 3 requisições/segundo e trata 401/429/5xx, timeout, backoff e Retry-After. Há limite preventivo de 100 mil requisições/dia UTC desta instância; outras integrações podem consumir a cota da conta. Contas com grande volume precisam evoluir para sincronização incremental/eventos antes de reduzir intervalos.
- Falhas não substituem snapshots completos por totais parciais. A tela informa horário e erros; falta de dado é `null`, nunca um zero inventado. Sem snapshot completo do período atual, totais ficam indisponíveis.

## Marketplaces e webhooks

`server/marketplaces.js` define adaptadores `listingsForSku(exactSku)`. Um resultado deve conter `sku`, `marketplace`, `listingId`, `url`, `publishedPrice`, `fee`, `freight`, `tax`, `cost`, `adsPerUnit`, `basis`, `source`, `updatedAt`, `currency`, `period` e métricas de performance (vendas, faturamento, gasto Ads e receita atribuída). Valores ausentes ficam nulos. Só se calcula margem quando todos os componentes numéricos compartilham a base `per-unit-BRL`. IDs de anúncio/variação e conta devem compor a chave do provedor: um SKU pode ter vários anúncios. Não associar lojas Bling a Mercado Livre/Shopee por suposição.

Mercado Livre e Shopee ainda não têm adaptadores autenticados: são pontos de extensão, não integrações prontas. Preço publicado, comissões liquidadas, frete, Ads, receita atribuída e devoluções virão das APIs e autorizações próprias. Manter estimativas por anúncio separadas dos resultados realizados por pedido/período; ROAS requer receita atribuída e gasto Ads comparáveis.

Nesta fase foi escolhido polling: ainda não existe endpoint público registrado, e ele também serve como reconciliação. Webhooks não foram anunciados como ativos. Ao adicioná-los, validar `X-Bling-Signature-256` com HMAC SHA-256 sobre os bytes originais usando client secret, persistir evento idempotente antes de responder 2xx em menos de 5 segundos, processar em fila e refazer leitura do recurso para eventos fora de ordem.

## Referências oficiais

- https://developer.bling.com.br/aplicativos
- https://developer.bling.com.br/referencia
- https://developer.bling.com.br/limites
- https://developer.bling.com.br/webhooks

Contrato de endpoints conferido em 28/09/2026 no OpenAPI publicado pelo Bling. A validação contra a conta real e as permissões efetivas depende da autorização.
