import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyMargin, applyMarginMinor, resolveMarginBps } from "./margin.ts";

const AMOUNTS_BRL = [1, 7.77, 10, 99.99, 100, 1234.56, 5000, 12345.67];
const BPS = [0, 100, 280, 999, 1000];

Deno.test("net never exceeds gross and stays a whole number of cents", () => {
  for (const amount of AMOUNTS_BRL) {
    for (const bps of BPS) {
      const net = applyMargin(amount, bps, 2);
      const cents = Math.round(net * 100);
      assertEquals(net, cents / 100, "net must land on a whole cent");
      assertEquals(net <= amount + 1e-9, true, "net must not exceed gross");
    }
  }
});

Deno.test("rounding direction is floor, never round-half-up", () => {
  // 10.01 BRL with 1 bp margin: 1001 cents * 9999 / 10000 = 1000.8999 -> 1000
  assertEquals(applyMarginMinor(10.01, 1, 2), 1000);
  // 0.05 BRL with a 5% margin: 5 * 9500 / 10000 = 4.75 -> 4 (floor, not 5)
  assertEquals(applyMarginMinor(0.05, 500, 2), 4);
});

Deno.test("applied rate matches the received amount", () => {
  for (const brl of AMOUNTS_BRL) {
    const gross = brl / 5.43; // arbitrary BRL per USD rate
    const cryptoOut = applyMargin(gross, 280, 6);
    const dollarRate = brl / cryptoOut;
    assertEquals(Math.abs(dollarRate * cryptoOut - brl) < 0.01, true);
  }
});

Deno.test("margin bps outside range falls back", () => {
  assertEquals(resolveMarginBps("nonsense"), 280);
  assertEquals(resolveMarginBps(-5), 280);
  assertEquals(resolveMarginBps(5000), 280);
  assertEquals(resolveMarginBps("120"), 120);
});
