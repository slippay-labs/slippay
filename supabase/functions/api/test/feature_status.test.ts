import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getFeatureStatus } from "../lib/features.ts";

Deno.test("getFeatureStatus reports disabled features when env vars missing", () => {
  const originalRelayer = Deno.env.get("RELAYER_SECRET");
  const originalDune = Deno.env.get("DUNE_API_KEY");
  const originalEtherfuse = Deno.env.get("ETHERFUSE_ENABLED");
  try {
    Deno.env.delete("RELAYER_SECRET");
    Deno.env.delete("DUNE_API_KEY");
    Deno.env.delete("ETHERFUSE_ENABLED");
    Deno.env.delete("CRIPTOPIX_ENABLED");
    Deno.env.delete("FOURP_API_KEY");

    const status = getFeatureStatus();
    const relayer = status.find((s) => s.name.includes("Relayer"));
    assertEquals(relayer?.enabled, false);

    const metrics = status.find((s) => s.name.includes("Metrics"));
    assertEquals(metrics?.enabled, false);

    const ramp = status.find((s) => s.name.includes("Ramp"));
    assertEquals(ramp?.enabled, false);
  } finally {
    if (originalRelayer) Deno.env.set("RELAYER_SECRET", originalRelayer);
    if (originalDune) Deno.env.set("DUNE_API_KEY", originalDune);
    if (originalEtherfuse) Deno.env.set("ETHERFUSE_ENABLED", originalEtherfuse);
  }
});

Deno.test("getFeatureStatus detects enabled features when configured", () => {
  const originalRelayer = Deno.env.get("RELAYER_SECRET");
  const originalDune = Deno.env.get("DUNE_API_KEY");
  const originalDuneActive = Deno.env.get("DUNE_Q_ACTIVE");
  try {
    Deno.env.set("RELAYER_SECRET", "SDEMOSECRET");
    Deno.env.set("DUNE_API_KEY", "dune-test-key");
    Deno.env.set("DUNE_Q_ACTIVE", "12345");

    const status = getFeatureStatus();
    const relayer = status.find((s) => s.name.includes("Relayer"));
    assertEquals(relayer?.enabled, true);

    const metrics = status.find((s) => s.name.includes("Metrics"));
    assertEquals(metrics?.enabled, true);
  } finally {
    if (originalRelayer) Deno.env.set("RELAYER_SECRET", originalRelayer);
    else Deno.env.delete("RELAYER_SECRET");
    if (originalDune) Deno.env.set("DUNE_API_KEY", originalDune);
    else Deno.env.delete("DUNE_API_KEY");
    if (originalDuneActive) Deno.env.set("DUNE_Q_ACTIVE", originalDuneActive);
    else Deno.env.delete("DUNE_Q_ACTIVE");
  }
});
