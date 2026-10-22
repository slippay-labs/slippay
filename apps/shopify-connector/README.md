# SlipPay × Shopify connector

Dois caminhos num servidor só (`src/index.mjs`, zero deps, node 18+):

- **Caminho A — usável hoje** (custom app + manual payment, sem aprovação da Shopify)
- **Caminho B — Payments App oficial** (checkout nativo; gate externo: Partner review da Shopify, acesso restrito)

Deployado em prod: PM2 `slippay-shopify` (:4001), exposto em
`https://api.slippay.cc/shopify/*` via proxy no API Deno (sem edit de nginx).

## Caminho A — fluxo

1. Merchant cria um **custom app** na admin da Shopify (Settings → Apps and sales
   channels → Develop apps → Create an app; sem review) com scopes Admin API
   `read_orders, write_orders`, e ativa um **manual payment method** chamado
   "SlipPay (USDC)" (Settings → Payments → Manual payment methods).
2. Shopify manda `orders/create` pra `/shopify/orders-create` (HMAC verificado; `SHOPIFY_WEBHOOK_SECRET` é obrigatório — sem ele o handler responde `503 webhook_not_configured` e não processa nada)
   → conector cria a ordem SlipPay (`external_ref = shopify:<order id>`).
3. Comprador abre `https://api.slippay.cc/shopify/pay/<nº do pedido>` (link fica
   nas instruções estáticas do manual payment: "Para pagar, acesse ... seguido
   do número do seu pedido") → 302 pro checkout SlipPay.
4. Listener SlipPay confirma o pagamento on-chain → `order.paid` em
   `/shopify/slippay-webhook` (assinatura `x-slippay-signature` verificada;
   `SLIPPAY_WEBHOOK_SECRET` é obrigatório, mínimo de 32 caracteres, e precisa
   bater com o secret configurado no listener — sem isso o handler responde
   `503 webhook_not_configured` e não marca o pedido como pago)
   → conector marca o pedido como pago na Shopify (Admin API transactions;
   capture com fallback pra sale) e anota o `tx_hash` no pedido.

## Setup por loja (checklist)

1. Custom app criado → copiar **Admin API access token** (`shpat_...`) e
   **API secret key** (assina os webhooks).
2. No dashboard SlipPay do merchant: copiar a **API key** (`sk_live_...`) e o
   **webhook secret** (mínimo de 32 caracteres, obrigatório — o mesmo valor
   precisa estar configurado no listener SlipPay); setar o **webhook URL** do merchant para
   `https://api.slippay.cc/shopify/slippay-webhook`; setar o **Stellar receive
   address** (com trustline USDC) — sem ele o checkout não tem alvo.
3. No servidor, `/opt/slippay-backend/.env.shopify`:
   ```
   SLIPPAY_API_KEY=sk_live_...
   SLIPPAY_WEBHOOK_SECRET=...
   SHOPIFY_WEBHOOK_SECRET=...          # API secret key do custom app
   SHOPIFY_SHOP=loja.myshopify.com
   SHOPIFY_ACCESS_TOKEN=shpat_...
   ```
   depois `pm2 restart slippay-shopify`.
4. Registrar o webhook da loja:
   `SHOPIFY_SHOP=... SHOPIFY_ACCESS_TOKEN=... node scripts/setup-shop.mjs`
5. Conferir `https://api.slippay.cc/shopify/health` — todos os flags `true`.

## Teste

`node test/e2e.mjs` (do diretório do app) — 13 asserts cobrindo HMAC dos dois
lados, dedup de redelivery, redirect do link de pagamento, match do order.paid
e persistência de estado.

## Suporte verificado

O que este repositório consegue evidenciar:

- **Node 18+** — exigido por `src/index.mjs` (zero deps); o e2e acima roda nesse runtime.
- **HMAC dos dois lados** — coberto pelos 13 asserts de `test/e2e.mjs`.
- **Dedup de redelivery, redirect do link de pagamento, match do `order.paid`,
  persistência de estado** — cobertos pelo mesmo e2e.

Não reivindicamos "testado" para versões específicas de plataforma nem para
HPOS: não há suíte de testes nem CI que sustente essas afirmações (issues 152 e
164). A semântica de replay de webhooks (issue 162) ainda não está fechada e
não é documentada aqui até ser definida.

## Limitações honestas

- Single-shop por processo (env por loja). Multi-tenant = tabela de shops, depois.
- `markShopifyOrderPaid` (capture → fallback sale) ainda não foi exercitado
  contra uma loja real — verificar no primeiro pedido de teste.
- Caminho B continua NÃO sendo um Payments App listado; review da Shopify é
  gate comercial, não código.
