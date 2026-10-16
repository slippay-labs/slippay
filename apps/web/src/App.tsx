import { Routes, Route } from "react-router-dom";
import AgentHome from "./pages/AgentHome.tsx";
import LandingV2 from "./pages/LandingV2.tsx";
import LandingV3 from "./pages/LandingV3.tsx";
import Builders from "./pages/Builders.tsx";
import Verify from "./pages/Verify.tsx";
import Home from "./pages/Home.tsx";
import Agents from "./pages/Agents.tsx";
import Comprovante from "./pages/Comprovante.tsx";
import Checkout from "./pages/Checkout.tsx";
import Sub from "./pages/Sub.tsx";
import Login from "./pages/Login.tsx";
import Signup from "./pages/Signup.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import DashboardOverview from "./pages/DashboardOverview.tsx";
import DashboardOrders from "./pages/DashboardOrders.tsx";
import DashboardSubscriptions from "./pages/DashboardSubscriptions.tsx";
import DashboardSettings from "./pages/DashboardSettings.tsx";
import Demo from "./pages/Demo.tsx";
import Preview from "./pages/Preview.tsx";
import X402Demo from "./pages/X402Demo.tsx";
import AnchorDemo from "./pages/AnchorDemo.tsx";
import WithdrawDemo from "./pages/WithdrawDemo.tsx";
import BioTest from "./pages/BioTest.tsx";
import PayDemo from "./pages/PayDemo.tsx";
import Cobrar from "./pages/Cobrar.tsx";
import Account from "./pages/Account.tsx";
import Cash from "./pages/Cash.tsx";
import Gate from "./pages/Gate.tsx";
import Store from "./pages/Store.tsx";
import PolicySubscribe from "./pages/PolicySubscribe.tsx";
import Docs from "./pages/Docs.tsx";
import Security from "./pages/Security.tsx";
import Manifesto from "./pages/Manifesto.tsx";
import Investors from "./pages/Investors.tsx";
import Conformidade from "./pages/Conformidade.tsx";
import PixPay from "./pages/PixPay.tsx";
import Vault from "./pages/Vault.tsx";
import ZkRedirect from "./pages/ZkRedirect.tsx";
import Receber from "./pages/Receber.tsx";
import Empresas from "./pages/Empresas.tsx";


import ComexBase from "./pages/ComexBase.tsx";
import { ComexBaseProvider } from "./lib/comexBase.tsx";
import BusinessLanding from "./pages/comex/BusinessLanding";
export default function App() {
  return (
    <Routes>
      {/* ── Landing & Campaign Routes ── */}
      {/* Canonical main landing */}
      <Route path="/" element={<LandingV2 />} />
      {/* Explicit versioned landing routes */}
      <Route path="/v2" element={<LandingV2 />} />
      <Route path="/v3" element={<LandingV3 />} />
      {/* Legacy v1 agent landing (preserved for historical bookmarks) */}
      <Route path="/v1" element={<AgentHome />} />
      {/* Marketing campaign alias for LandingV2 */}
      <Route path="/cofrinho-landing" element={<LandingV2 />} />
      <Route path="/zk" element={<ZkRedirect />} />
      <Route path="/human" element={<Home />} />

      {/* ── Cash / Ramp Routes ── */}
      {/* Canonical cash on/off-ramp */}
      <Route path="/cash" element={<Cash />} />
      {/* Localized aliases for cash ramp (PT / EN / Pix) */}
      <Route path="/buy" element={<Cash />} />
      <Route path="/comprar" element={<Cash />} />
      <Route path="/pix" element={<Cash />} />
      {import.meta.env.VITE_PAGFINANCE_ENABLED === "1" && <Route path="/pix-pay" element={<PixPay />} />}

      {/* ── Business & Enterprise (B2B) Routes ── */}
      {/* Canonical B2B landing in primary PT */}
      <Route path="/empresas" element={<Empresas />} />
      {/* Global / English alias for enterprise */}
      <Route path="/b2b" element={<Empresas />} />

      {/* ── Compliance Routes ── */}
      {/* Canonical global route */}
      <Route path="/compliance" element={<Conformidade />} />
      {/* Localized Portuguese alias */}
      <Route path="/conformidade" element={<Conformidade />} />

      {/* ── Security Routes ── */}
      {/* Canonical global route */}
      <Route path="/security" element={<Security />} />
      {/* Localized Portuguese alias */}
      <Route path="/seguranca" element={<Security />} />

      {/* ── Investor & Pitch Routes ── */}
      {/* Canonical global route */}
      <Route path="/investors" element={<Investors />} />
      {/* Localized Portuguese alias */}
      <Route path="/investidores" element={<Investors />} />
      {/* Marketing / Pitch deck shortcut */}
      <Route path="/pitch" element={<Investors />} />

      {/* ── Core Commerce & Payments ── */}
      <Route path="/checkout/:order_id" element={<Checkout />} />
      <Route path="/receber" element={<Receber />} />
      <Route path="/cobrar" element={<Cobrar />} />
      <Route path="/comprovante/:txhash" element={<Comprovante />} />
      <Route path="/sub/:id" element={<Sub />} />
      <Route path="/s/:subId" element={<PolicySubscribe />} />
      <Route path="/gate" element={<Gate />} />
      <Route path="/loja" element={<Store />} />

      {/* ── Auth & Account ── */}
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/account" element={<Account />} />
      <Route path="/verify" element={<Verify />} />

      {/* ── Ecosystem, Comex & Vault ── */}
      {import.meta.env.VITE_COMEX_ENABLED === "1" && (
        <Route path="/comex" element={
          import.meta.env.VITE_PRIVY_APP_ID
            ? <ComexBaseProvider><ComexBase /></ComexBaseProvider>
            : <BusinessLanding />
        } />
      )}
      {import.meta.env.VITE_DEFINDEX_ENABLED === "1" && <Route path="/cofre" element={<Vault />} />}
      <Route path="/builders" element={<Builders />} />
      <Route path="/agents" element={<Agents />} />
      <Route path="/manifesto" element={<Manifesto />} />
      <Route path="/docs" element={<Docs />} />
      <Route path="/docs/*" element={<Docs />} />

      {/* ── Interactive Demos & Testing Surfaces ── */}
      <Route path="/demo" element={<Demo />} />
      <Route path="/preview" element={<Preview />} />
      <Route path="/x402-demo" element={<X402Demo />} />
      <Route path="/anchor-demo" element={<AnchorDemo />} />
      <Route path="/withdraw-demo" element={<WithdrawDemo />} />
      <Route path="/bio" element={<BioTest />} />
      <Route path="/pay" element={<PayDemo />} />

      {/* ── Merchant Dashboard ── */}
      <Route path="/dashboard" element={<Dashboard />}>
        <Route index element={<DashboardOverview />} />
        <Route path="orders" element={<DashboardOrders />} />
        <Route path="subscriptions" element={<DashboardSubscriptions />} />
        <Route path="settings" element={<DashboardSettings />} />
      </Route>

      {/* ── Fallback ── */}
      <Route path="*" element={<div className="p-8">not found</div>} />
    </Routes>
  );
}
