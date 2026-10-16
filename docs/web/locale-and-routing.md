# Web Application Locale Strategy & Routing Architecture

This document establishes the single source of truth for internationalization (i18n), locale resolution, visual theme tokens, and routing invariants across `@slippay/web` (Issue #334).

---

## 1. Supported Locales & Audience Strategy

SlipPay operates primarily as the borderless settlement gateway for Brazilian professionals, developers, exporters, and digital creators who earn in US Dollars (USDC) and spend locally via Pix.

| Locale Code | Status | Target Audience | Canonical Language Tag |
| :--- | :---: | :--- | :--- |
| **`pt`** | **PRIMARY** | Brazilian IT/dev exporters, freelancers, gig workers, Comex merchants | `pt-BR` |
| **`en`** | **SECONDARY** | International partners, global developers, liquidity providers, investors | `en` |

### Rationale
- **Portuguese as First Citizen (`pt`)**: The core product conversion loop hinges on trust in Brazilian financial rails (Pix, CPF/CNPJ validation, Comex compliance). Defaulting to Portuguese ensures zero-friction onboarding for the primary market.
- **English as Secondary Mirror (`en`)**: Global investors, cross-chain developers, and international buyers need full visibility into the protocol, documentation, and checkout flows without browser auto-translate artifacts.

---

## 2. Locale Detection & Persistence Rules (`lib/lang.ts`)

Locale resolution follows a strict three-tier precedence hierarchy with deterministic fallbacks:

```
+-------------------------------------------------------------+
| 1. Explicit Stored Preference (localStorage: slippay_lang)   |
|    - Validated against allowlist: ['pt', 'en']              |
+------------------------------+------------------------------+
                               | (empty / invalid / storage failure)
                               v
+-------------------------------------------------------------+
| 2. Browser Environment (navigator.language)                 |
|    - If starts with 'en' (e.g. en-US, en-GB) -> 'en'        |
+------------------------------+------------------------------+
                               | (non-English or navigator unavailable)
                               v
+-------------------------------------------------------------+
| 3. Default Fallback                                         |
|    - Always returns DEFAULT_LANG ('pt')                     |
+-------------------------------------------------------------+
```

### Invariants:
1. **Allowlist Sanitization**: Unrecognized stored values (such as `"es"`, `"fr"`, `"unknown"`) are automatically discarded by `normalizeLang()` and fall back to `DEFAULT_LANG`.
2. **Storage Isolation & Fault Tolerance**: Storage access (`getItem` / `setItem`) is wrapped in defensive `try/catch` to guarantee zero crashes in private browsing mode, disabled cookie environments, or server-side rendering (SSR).
3. **DOM Attribute Synchronization**: Whenever `lang` transitions, `document.documentElement.lang` is immediately synchronized (`pt-BR` for `pt`, `en` for `en`) to ensure screen readers (a11y) and search engine indexing operate accurately.

---

## 3. Visual Theme Tokens & Persistence (`lib/darkTheme.ts`)

SlipPay adheres to the **Secuury / V3** design register: an immersive, low-contrast dark canvas engineered for financial focus, high data density, and security telemetry.

### Core Color Palette Tokens (`DARK`)
| Token | Hex / Value | Semantic Role |
| :--- | :--- | :--- |
| `DARK.bg` | `#0a0e1a` | Deep navy base canvas |
| `DARK.bg2` | `#0d1322` | Surface panels and card backgrounds |
| `DARK.ink` | `#f3f5fb` | Primary text / high-contrast typography |
| `DARK.muted` | `#8a93ad` | Secondary labels, captions, metadata |
| `DARK.cyan` | `#22d3ee` | Electric cyan brand accent & primary CTAs |
| `DARK.cyan2` | `#38bdf8` | Secondary gradient accent & link hovers |
| `DARK.line` | `rgba(255, 255, 255, 0.08)` | Structural borders and split dividers |
| `DARK.ok` | `#34d399` | Success state, verified signatures, confirmations |
| `DARK.leak` | `#fb7185` | Error state, balance deficits, security alerts |

### Persistence Policy
- Key: `slippay_theme` (`THEME_KEY`)
- Supported values: `"dark"` | `"system"`
- Default: `DEFAULT_THEME = "dark"`
- The platform defaults to the dark palette across all routes to prevent flash-of-white (FOW) during initial paint.

---

## 4. Canonical Route Set & Legacy/Alias Route Matrix

To balance modern SEO structure, bilingual user habits, and strict backwards-compatibility (preventing dead links from historical campaign materials and external pitch decks), SlipPay maintains canonical primary routes alongside documented aliases.

| Semantic Domain | Canonical Route | Localized / Legacy Aliases | Target Component | Purpose & Preservation Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Landing** | `/` | `/v2`, `/cofrinho-landing` | `LandingV2` | Canonical product showcase. `/cofrinho-landing` is preserved for historical QR/flyer campaigns in Brazil; `/v2` provides explicit version targeting. |
| **Next Landing**| `/v3` | — | `LandingV3` | Secuury/V3 register design showcase. |
| **Legacy Agent**| `/v1` | — | `AgentHome` | Preserved for machine/agent integrations referencing early API landing materials. |
| **Cash / Ramp** | `/cash` | `/buy`, `/comprar`, `/pix` | `Cash` | Canonical on/off-ramp portal. `/comprar` supports native Portuguese queries; `/pix` provides a direct mental link for local Pix payments; `/buy` serves English users. |
| **Enterprise** | `/empresas` | `/b2b` | `Empresas` | Canonical Brazilian B2B onboarding. `/b2b` serves global enterprise integrations. |
| **Compliance** | `/compliance` | `/conformidade` | `Conformidade` | Canonical legal and compliance documentation. `/conformidade` preserves Portuguese administrative bookmarks. |
| **Security** | `/security` | `/seguranca` | `Security` | Canonical security audit disclosures. `/seguranca` is the localized counterpart. |
| **Investors** | `/investors` | `/investidores`, `/pitch` | `Investors` | Canonical deck and metrics. `/investidores` is the localized counterpart; `/pitch` is the historical short-link distributed to venture partners. |
| **Checkout** | `/checkout/:order_id`| — | `Checkout` | Canonical universal checkout session route. |
| **Billing** | `/sub/:id` | `/s/:subId` (`PolicySubscribe`) | `Sub` / `PolicySubscribe` | Canonical subscription management and direct policy enrollment shortcut. |
| **Receipt** | `/comprovante/:txhash`| — | `Comprovante` | Canonical on-chain receipt verification (Stellar / Solana). |
| **Dashboard** | `/dashboard/*` | — | `Dashboard` | Merchant control center (orders, subscriptions, settings). |

### Policy on Route Deprecation
- **No Silent Removals**: Canonical routes must remain stable. Aliases listed above are zero-overhead client-side routes and **must not be deleted** without explicit redirection (HTTP 301 / client-side `<Navigate replace />`), as external merchants and payment QR codes rely on them.

---

## 5. Verification & Testing

Both `lib/lang.ts` and `lib/darkTheme.ts` are covered by automated unit test suites under `apps/web/test/`:
- `test/lang.test.ts`: Asserts default fallback to `pt`, English detection, allowlist sanitization, exception resilience, and DOM attribute binding.
- `test/darkTheme.test.ts`: Asserts color token immutability, Tailwind utility consistency, default `dark` theme, allowlist normalization, and safe storage mutation.
