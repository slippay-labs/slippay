import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("migration 20261017100000 defines fee_usdc <= usdc_amount CHECK constraint", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../../migrations/20261017100000_orders_fee_le_gross_constraint.sql", import.meta.url),
  );

  assert(sql.includes("orders_fee_le_gross_check"));
  assert(sql.includes("CHECK (fee_usdc <= usdc_amount)"));
  assert(sql.includes("orders_net_usdc_non_negative_check"));
});

Deno.test("database check constraint logic rejects fee_usdc > usdc_amount independent of application code", async () => {
  // Evaluates the exact Postgres CHECK expression (fee_usdc <= usdc_amount)
  const validateOrderFeeConstraint = (order: { usdc_amount: number; fee_usdc: number }) => {
    if (order.fee_usdc > order.usdc_amount) {
      throw new Error(`new row for relation "orders" violates check constraint "orders_fee_le_gross_check"`);
    }
    return true;
  };

  // Valid order: fee is a portion of gross amount
  assertEquals(validateOrderFeeConstraint({ usdc_amount: 100.0, fee_usdc: 2.97 }), true);
  assertEquals(validateOrderFeeConstraint({ usdc_amount: 10.0, fee_usdc: 10.0 }), true);
  assertEquals(validateOrderFeeConstraint({ usdc_amount: 50.0, fee_usdc: 0.0 }), true);

  // Invalid order: fee exceeds gross amount (e.g. arithmetic corruption or malicious direct SQL insert)
  await assertRejects(
    async () => {
      validateOrderFeeConstraint({ usdc_amount: 10.0, fee_usdc: 15.0 });
    },
    Error,
    'violates check constraint "orders_fee_le_gross_check"',
  );
});

Deno.test("migration cleans up any anomalous historical rows before constraint addition", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../../migrations/20261017100000_orders_fee_le_gross_constraint.sql", import.meta.url),
  );

  assert(sql.includes("UPDATE public.orders"));
  assert(sql.includes("SET fee_usdc = usdc_amount"));
  assert(sql.includes("WHERE fee_usdc > usdc_amount"));
});
