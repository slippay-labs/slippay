import { z } from "zod";

export const ORDER_MIN_EXPIRY_MINUTES = 5;
export const ORDER_MAX_EXPIRY_MINUTES = 1440;
export const ORDER_DEFAULT_EXPIRY_MINUTES = 30;

export const OrderExpiryMinutesSchema = z
  .number()
  .int()
  .min(ORDER_MIN_EXPIRY_MINUTES)
  .max(ORDER_MAX_EXPIRY_MINUTES);

/**
 * Validates and resolves the expiry duration and timestamp for an order.
 * Ensures the resolved minutes (user-provided or default) strictly satisfies the schema
 * and that the resulting ISO timestamp is in the future and within the max allowed window.
 */
export function resolveOrderExpiry(
  expiresInMinutes?: number | null,
  nowMs: number = Date.now(),
): { minutes: number; expiresAt: string } {
  const resolvedMinutes = expiresInMinutes ?? ORDER_DEFAULT_EXPIRY_MINUTES;
  const validatedMinutes = OrderExpiryMinutesSchema.parse(resolvedMinutes);

  const expiresAtMs = nowMs + validatedMinutes * 60_000;
  if (expiresAtMs <= nowMs || expiresAtMs > nowMs + ORDER_MAX_EXPIRY_MINUTES * 60_000 + 1000) {
    throw new Error(`Invalid expiresAt calculation: ${expiresAtMs}`);
  }

  return {
    minutes: validatedMinutes,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

const fiatAmount = z.string().regex(/^\d{1,9}\.\d{2}$/, "must be string with 2 decimals");

// USDC amount schema: decimal-string with max 7 fractional places and > 0.
export const UsdcAmountSchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,7})?$/, "must be decimal string with at most 7 fractional places")
  .refine(v => parseFloat(v) > 0, "must be > 0");

// Either brl_amount OR usd_amount must be set, not both. usd_amount lets
// BR-export merchants invoice global customers in USD without going through
// a BRL conversion round-trip — usdc_amount = usd_amount (1:1, USDC is a
// USD-pegged stablecoin, ignoring CoinGecko spread).
export const CreateOrderInputSchema = z.object({
  brl_amount: fiatAmount.refine(v => parseFloat(v) > 0, "must be > 0").optional(),
  usd_amount: UsdcAmountSchema.optional(),
  external_ref: z.string().max(120).optional(),
  expires_in_minutes: OrderExpiryMinutesSchema.optional(),
}).refine(
  (d) => (d.brl_amount && !d.usd_amount) || (!d.brl_amount && d.usd_amount),
  { message: "exactly one of brl_amount or usd_amount must be set" },
);

export const OrderStatusSchema = z.enum([
  "pending","paid","underpaid","expired","cancelled","dead",
]);

export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
