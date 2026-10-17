# SlipPay Security Architecture: Proxy-Hop & Secret Trust Model

> Canonical Reference: `docs/security/trust-model.md`  
> Cross-references: [audit-001.md](./audit-001.md), [audit-002.md](./audit-002.md), [audit-003.md](./audit-003.md), [audit-004.md](./audit-004.md), [audit-005.md](./audit-005.md), [audit-006.md](./audit-006.md), [key-custody.md](./key-custody.md).

---

## 1. Network Topology & Request Path (Proxy-Hop Architecture)

### 1.1 Ingress Request Flow

All inbound HTTP(S) requests traverse a multi-tier proxy architecture before arriving at the Deno edge function runtime:

```
[Client / Merchant / Browser]
            │
            ▼
┌───────────────────────────────────────┐
│ Hop 1: Ingress Gateway / Nginx / Kong │ (Terminates TLS, appends peer socket IP)
└───────────────────────────────────────┘
            │
            ▼
┌───────────────────────────────────────┐
│ Hop 2: Deno Edge Function Runtime     │ (Deno.serve / Hono router)
│        (supabase/functions/api)       │
└───────────────────────────────────────┘
            │
            ▼
┌───────────────────────────────────────┐
│ Supabase PostgreSQL (pgvector/RLS)    │
└───────────────────────────────────────┘
```

### 1.2 Header Trust & Client IP Derivation

| Header / Field | Source / Trust Level | Handling Policy |
| :--- | :--- | :--- |
| `remoteAddr` | Direct socket peer (TCP connection info) | **Highest trust**. If present and non-loopback/non-private, used directly. |
| `X-Forwarded-For` | Multi-hop proxy chain | **Positional trust**. The left-most entry is client-controlled and forgeable. The hop at `TRUSTED_PROXY_HOPS` depth from the **RIGHT** is appended by the ingress gateway and trusted. |
| `X-Real-IP` | Ingress Gateway (Nginx / Kong) | **Secondary trust**. Trusted only if configured and forwarded by the gateway. |
| `CF-Connecting-IP` | Cloudflare Edge | **Conditional trust**. Validated when Cloudflare proxying is active in front of ingress. |

### 1.3 `TRUSTED_PROXY_HOPS` Value & Topology Alignment

- **Configuration Key**: `TRUSTED_PROXY_HOPS` (env var in `supabase/functions/api/lib/client_ip.ts`).
- **Standard Default**: `1`.
- **Topological Justification**:
  In standard deployment (Fly.io / Supabase self-hosted / Supabase cloud), exactly one trusted gateway proxy (Kong or Nginx) sits directly in front of the Deno isolate. It appends the connecting client's IP as the rightmost hop in `X-Forwarded-For`.
  - When an additional edge CDN (e.g. Cloudflare) is placed in front of Kong, `TRUSTED_PROXY_HOPS` MUST be tuned to `2` if Kong preserves the entire chain without overriding `X-Forwarded-For`.

---

## 2. Secret Inventory & Lifecycle Management Matrix

Every credential in the SlipPay ecosystem is inventoried below with its storage location, consumer scope, rotation runbook, and rotation cadence:

| Secret Name | Purpose & Cryptographic Role | Storage Location | Consumer Scope | Rotation Cadence | Rotation Procedure & Impact |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin bypass for RLS; internal sync & listener reconciler | Supabase Dashboard / Fly.io secrets | `apps/listener`, CI workflows | 90 days / on breach | Generate new JWT in Supabase API settings; update Fly.io secret `fly secrets set SUPABASE_SERVICE_ROLE_KEY=...`; rolling restart listener. |
| `SUPABASE_ANON_KEY` | Public client token for authenticated RLS queries | Apps environment / Vercel | `apps/web`, checkout UI | 180 days | Update Supabase JWT secret; re-deploy frontend assets. |
| `API_KEY_PEPPER` | HMAC-SHA-256 pepper for merchant API key verification (`apikey.ts`) | Supabase Edge Function Secrets | `supabase/functions/api` | Annual / on breach | Zero-downtime rotation: API supports legacy fallback hash during transition; merchants trigger `/me/rotate-key` to re-hash under new pepper. |
| `CHECKOUT_TOKEN_SECRET` | HMAC-SHA-256 key for public order read URL verification (`?t=...`) | Supabase Edge Function Secrets | `supabase/functions/api` | 180 days | Set new secret; active checkout sessions valid for max `ORDER_MAX_EXPIRY_MINUTES` (60m) will need page refresh if unexpired. |
| `SLIPPAY_API_KEY` | E-commerce connector merchant credentials | VTEX / Shopify App Settings | Connector apps | Merchant-driven | Merchant generates new key in Dashboard `/settings/keys`; pastes in Shopify/VTEX app dashboard; old key revoked. |
| `SLIPPAY_WEBHOOK_SECRET` | Webhook signature HMAC key (`t=<ts>,v1=<hex>`) | Merchant DB / Connector env | Connector apps | Merchant-driven | Rotate in Merchant Settings; connectors support dual secret array during cutover window. |
| `SHOPIFY_APP_SECRET` / `SHOPIFY_WEBHOOK_SECRET` | Shopify OAuth & HMAC verification | Fly.io secrets | `apps/shopify-connector` | Annual | Update in Shopify Partner Dashboard; update `SHOPIFY_APP_SECRET` via `fly secrets set`. |
| `STELLAR_USDC_ISSUER_OVERRIDE` | Testnet issuer simulation key | Environment config | `apps/listener` (test only) | Static per network | Pointed to testnet issuer address in development/staging; mainnet uses canonical Circle issuer. |

---

## 3. Communication Trust Boundaries

### 3.1 Outbound Webhooks (SSRF Defense)
- **Component**: `apps/listener/src/ssrf.ts`
- **Trust Assumption**: Hostnames provided by merchants are **untrusted**.
- **Enforcement**:
  - Outbound DNS resolution is performed locally via `node:dns/promises`.
  - All returned IPs are checked against RFC1918, RFC6598 (CGNAT), RFC3927 (link-local), cloud metadata (`169.254.169.254`), 6to4, Teredo, and IPv4-mapped IPv6 ranges.
  - Undici custom agent pins the resolved IP to prevent DNS rebinding attacks.

### 3.2 Database Row-Level Security (RLS)
- **Component**: `supabase/migrations/`
- **Trust Assumption**: Anonymous clients (`anon`) must only read public order checkout tokens and never query merchant financial ledgers.
- **Enforcement**:
  - `orders` table enforces RLS: authenticated merchants query only `merchant_id = auth.uid()`.
  - Public checkout reads go through service-role validated Edge Functions with `checkout-token` HMAC verification.

---

## 4. Audit Reference Mapping

The repository security controls address specific findings documented in the audit series:

| Audit Document | Finding Ref | Addressed Control & Source File |
| :--- | :--- | :--- |
| [`audit-001.md`](./audit-001.md) | High-severity escrow timing | Smart contract checkout bounds & expiration logic (`contracts/checkout`) |
| [`audit-002.md`](./audit-002.md) | Double-credit idempotency | Database unique constraint on `(network, tx_hash)` in reconciler |
| [`audit-003.md`](./audit-003.md) | L1 (SSRF outbound delivery) | `apps/listener/src/ssrf.ts` IP pinning and blocklist |
| [`audit-004.md`](./audit-004.md) | C2 (Public order guessing), C4 (API key pepper) | `supabase/functions/api/lib/checkout-token.ts`, `lib/apikey.ts` |
| [`audit-005.md`](./audit-005.md) | H1 (Client IP spoofing / rate-limit evasion) | `supabase/functions/api/lib/client_ip.ts` (TRUSTED_PROXY_HOPS) |
| [`audit-006.md`](./audit-006.md) | M1-M4 (Listener resilience, cursor persistence) | `apps/listener/src/horizon.ts` (cursor self-healing & lease heartbeat) |
