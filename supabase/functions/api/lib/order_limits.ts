import { DEFAULT_MAX_ORDER_USDC, DEFAULT_MAX_ORDER_BRL } from "@slippay/shared";

export interface OrderLimitCheckResult {
  allowed: boolean;
  currency?: string;
  amount?: string;
  max_allowed?: string;
  message?: string;
}

/**
 * Validates order amounts against per-merchant configurable limits, defaulting
 * to canonical system defaults (Issue #208).
 */
export function checkOrderLimits(
  merchant: { max_order_usdc?: number | string | null; max_order_brl?: number | string | null } | null | undefined,
  amount: { usd_amount?: string | null; brl_amount?: string | null; usdc_amount?: string | null },
): OrderLimitCheckResult {
  const maxUsdc = merchant?.max_order_usdc ? Number(merchant.max_order_usdc) : DEFAULT_MAX_ORDER_USDC;
  const maxBrl = merchant?.max_order_brl ? Number(merchant.max_order_brl) : DEFAULT_MAX_ORDER_BRL;

  if (amount.usd_amount) {
    const val = parseFloat(amount.usd_amount);
    if (val > maxUsdc) {
      return {
        allowed: false,
        currency: "USD",
        amount: amount.usd_amount,
        max_allowed: maxUsdc.toFixed(7),
        message: `Order amount ${amount.usd_amount} exceeds merchant limit of ${maxUsdc} USDC`,
      };
    }
  }

  if (amount.brl_amount) {
    const val = parseFloat(amount.brl_amount);
    if (val > maxBrl) {
      return {
        allowed: false,
        currency: "BRL",
        amount: amount.brl_amount,
        max_allowed: maxBrl.toFixed(2),
        message: `Order amount ${amount.brl_amount} exceeds merchant limit of ${maxBrl} BRL`,
      };
    }
  }

  if (amount.usdc_amount) {
    const val = parseFloat(amount.usdc_amount);
    if (val > maxUsdc) {
      return {
        allowed: false,
        currency: "USDC",
        amount: amount.usdc_amount,
        max_allowed: maxUsdc.toFixed(7),
        message: `Calculated order amount ${amount.usdc_amount} USDC exceeds merchant limit of ${maxUsdc} USDC`,
      };
    }
  }

  return { allowed: true };
}
