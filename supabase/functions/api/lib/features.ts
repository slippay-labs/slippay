// Optional feature detection and diagnostic logging at API boot time (#492).
// Logs which optional integrations (Relayer, Ramps, Dune Metrics, On-chain Subscriptions, Ask AI)
// are active or disabled, and explains the reason so 503 errors can be understood immediately.

export interface FeatureStatus {
  name: string;
  enabled: boolean;
  reason?: string;
}

export function getFeatureStatus(): FeatureStatus[] {
  const net = (Deno.env.get("STELLAR_NETWORK") ?? "testnet").toLowerCase();
  const features: FeatureStatus[] = [];

  // 1. Gas Relayer
  const relayerSecret = Deno.env.get("RELAYER_SECRET");
  if (relayerSecret) {
    features.push({ name: "Gas Relayer (/v1/relayer)", enabled: true });
  } else {
    features.push({
      name: "Gas Relayer (/v1/relayer)",
      enabled: false,
      reason: "RELAYER_SECRET not set (requests return 503)",
    });
  }

  // 2. Ramp (Etherfuse / CriptoPix)
  const etherfuseOn = Deno.env.get("ETHERFUSE_ENABLED") === "1" && !!Deno.env.get("ETHERFUSE_API_KEY");
  const criptoPixOn = Deno.env.get("CRIPTOPIX_ENABLED") === "1" && !!Deno.env.get("CRIPTOPIX_CLIENT_ID");
  if (etherfuseOn || criptoPixOn) {
    const provider = criptoPixOn ? "CriptoPix" : "Etherfuse";
    features.push({ name: `Ramp (${provider}) (/v1/offramp)`, enabled: true });
  } else {
    features.push({
      name: "Ramp (/v1/offramp)",
      enabled: false,
      reason: "neither ETHERFUSE nor CRIPTOPIX configured (returns 503)",
    });
  }

  // 3. 4P Finance
  const fourpKey = Deno.env.get("FOURP_API_KEY");
  if (fourpKey) {
    features.push({ name: "4P Finance Ramp (/v1/4p)", enabled: true });
  } else {
    features.push({
      name: "4P Finance Ramp (/v1/4p)",
      enabled: false,
      reason: "FOURP_API_KEY not set (dormant)",
    });
  }

  // 4. Dune Metrics
  const duneKey = Deno.env.get("DUNE_API_KEY");
  const duneActive = Deno.env.get("DUNE_Q_ACTIVE");
  if (duneKey && duneActive) {
    features.push({ name: "Dune Metrics (/v1/metrics)", enabled: true });
  } else {
    features.push({
      name: "Dune Metrics (/v1/metrics)",
      enabled: false,
      reason: "DUNE_API_KEY or query IDs not set (returns configured: false)",
    });
  }

  // 5. Subscriptions on-chain contract
  const subContract = net === "mainnet" || net === "public"
    ? Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET")
    : Deno.env.get("SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET");
  if (subContract) {
    features.push({ name: `On-chain Subscriptions (${net})`, enabled: true });
  } else {
    features.push({
      name: `On-chain Subscriptions (${net})`,
      enabled: false,
      reason: `SLIPPAY_SUBSCRIPTION_CONTRACT_${net.toUpperCase()} not set (onchain-charge returns 409)`,
    });
  }

  // 6. Ask Concierge
  const askSpawns = Deno.env.get("ASK_MAX_SPAWNS_PER_DAY");
  features.push({
    name: "Ask AI (/v1/ask)",
    enabled: true,
    reason: askSpawns ? `max spawns: ${askSpawns}/day` : "running on defaults",
  });

  return features;
}

export function logFeatureStatus(): FeatureStatus[] {
  const features = getFeatureStatus();
  console.log("[features] Optional feature configuration status:");
  for (const f of features) {
    if (f.enabled) {
      console.log(`  ✓ ${f.name}: ENABLED${f.reason ? ` (${f.reason})` : ""}`);
    } else {
      console.log(`  ✗ ${f.name}: DISABLED - ${f.reason}`);
    }
  }
  return features;
}
