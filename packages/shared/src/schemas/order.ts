import { z } from "zod";
import { SYSTEM_MAX_ORDER_BRL, SYSTEM_MAX_ORDER_USDC } from "../constants.ts";

export const fiatAmount = z
  .string()
  .regex(/^\d{1,9}\.\d{2}$/, "must be string with 2 decimals")
  .refine(v => parseFloat(v) > 0, "must be > 0")
  .refine(v => parseFloat(v) <= SYSTEM_MAX_ORDER_BRL, `exceeds system maximum order limit of ${SYSTEM_MAX_ORDER_BRL} BRL`);

// USDC amount schema: decimal-string with max 7 fractional places and > 0, bounded by system ceiling.
export const UsdcAmountSchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,7})?$/, "must be decimal string with at most 7 fractional places")
  .refine(v => parseFloat(v) > 0, "must be > 0")
  .refine(v => parseFloat(v) <= SYSTEM_MAX_ORDER_USDC, `exceeds system maximum order limit of ${SYSTEM_MAX_ORDER_USDC} USDC`);

// Either brl_amount OR usd_amount must be set, not both. usd_amount lets
// BR-export merchants invoice global customers in USD without going through
// a BRL conversion round-trip — usdc_amount = usd_amount (1:1, USDC is a
// USD-pegged stablecoin, ignoring CoinGecko spread).
export const CreateOrderInputSchema = z.object({
  brl_amount: fiatAmount.refine(v => parseFloat(v) > 0, "must be > 0").optional(),
  usd_amount: UsdcAmountSchema.optional(),
  external_ref: z.string().max(120).optional(),
  expires_in_minutes: z.number().int().min(5).max(1440).optional(),
}).refine(
  (d) => (d.brl_amount && !d.usd_amount) || (!d.brl_amount && d.usd_amount),
  { message: "exactly one of brl_amount or usd_amount must be set" },
);

export const OrderStatusSchema = z.enum([
  "pending","paid","underpaid","expired","cancelled","dead",
]);

export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
