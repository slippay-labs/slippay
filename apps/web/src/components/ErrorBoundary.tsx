import { Component, type ErrorInfo, type ReactNode } from "react";
import { DARK, dk } from "../lib/darkTheme.js";

export interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  orderId?: string;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorId: string | null;
}

/**
 * Sanitizes error messages and traces so that zero session tokens,
 * private keys, signatures, or raw credentials leak into UI or logs.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return "";
  return raw
    // JWT / Bearer tokens
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]")
    // Bearer headers
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, "Bearer [REDACTED_TOKEN]")
    // Stellar Secret keys (S...)
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_SECRET]")
    // Hex private keys (32 bytes / 64 hex chars)
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[REDACTED_HEX_KEY]")
    // Query params like ?token= or ?secret=
    .replace(/([?&](?:token|secret|key|auth|session|access_token)=)[^&]+/gi, "$1[REDACTED]");
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorId: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    const errorId = `ERR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    return {
      hasError: true,
      error,
      errorId,
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const sanitizedMsg = sanitizeErrorMessage(error?.message || "");
    const name = this.props.name || "ErrorBoundary";
    console.error(`[${name}] Caught render failure:`, sanitizedMsg, info);

    if (this.props.onError) {
      this.props.onError(new Error(sanitizedMsg), info);
    }
  }

  reset = (): void => {
    if (this.props.onReset) {
      this.props.onReset();
    }
    this.state = {
      hasError: false,
      error: null,
      errorId: null,
    };
    try {
      if ((this as any)._reactInternals || (this as any).updater?.isMounted?.(this)) {
        this.setState({
          hasError: false,
          error: null,
          errorId: null,
        });
      }
    } catch {
      /* ignore if unmounted */
    }
  };

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }

      const isPayment = this.props.name?.toLowerCase().includes("payment") || !!this.props.orderId;
      const sanitizedMsg = sanitizeErrorMessage(this.state.error.message);

      return (
        <div
          data-testid="error-boundary-fallback"
          className="min-h-[360px] w-full flex items-center justify-center p-6"
          style={{ background: DARK.bg, color: DARK.ink }}
        >
          <div
            className="w-full max-w-lg p-6 sm:p-8 rounded-2xl border text-center shadow-2xl transition-all"
            style={{
              background: DARK.bg2,
              borderColor: "rgba(255, 255, 255, 0.1)",
            }}
          >
            {/* Warning Icon Badge */}
            <div className="mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 bg-rose-500/10 text-rose-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            <h2 className="text-xl font-bold tracking-tight mb-2">
              {isPayment ? "Erro no fluxo de pagamento" : "Ops! Algo deu errado"}
            </h2>

            <p className="text-sm opacity-80 mb-4 text-[#8a93ad]">
              {isPayment
                ? "Não foi possível carregar este módulo de pagamento com segurança. Seus fundos permanecem intactos."
                : "Ocorreu um erro temporário ao carregar este conteúdo."}
            </p>

            {this.props.orderId && (
              <div className="mb-4 py-2 px-3 rounded-lg text-xs font-mono bg-white/5 text-[#8a93ad] break-all">
                Pedido / Order: <span className="text-[#f3f5fb]">{this.props.orderId}</span>
              </div>
            )}

            <div className="mb-6 py-2 px-3 rounded-lg text-xs font-mono bg-black/30 border border-white/5 text-rose-300/80 overflow-hidden text-ellipsis whitespace-nowrap">
              {sanitizedMsg || "Render error occurred"}
            </div>

            {this.state.errorId && (
              <div className="text-[11px] font-mono text-[#8a93ad] mb-6">
                Ref: <span className="text-cyan-400">{this.state.errorId}</span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                data-testid="error-retry-button"
                onClick={this.reset}
                className={dk.cta}
              >
                Tentar novamente / Retry
              </button>

              <a
                href={`https://t.me/slippay_labs?text=Support+Ref:+${this.state.errorId}${this.props.orderId ? `+Order:+${this.props.orderId}` : ""}`}
                target="_blank"
                rel="noopener noreferrer"
                className={dk.ghost}
              >
                Falar com suporte →
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * High-level Error Boundary for Payment Routes
 */
export function PaymentErrorBoundary({
  children,
  orderId,
  onReset,
}: {
  children: ReactNode;
  orderId?: string;
  onReset?: () => void;
}) {
  return (
    <ErrorBoundary name="PaymentRoutes" orderId={orderId} onReset={onReset}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * Root Application Error Boundary
 */
export function AppRootErrorBoundary({
  children,
  onReset,
}: {
  children: ReactNode;
  onReset?: () => void;
}) {
  return (
    <ErrorBoundary name="AppRoot" onReset={onReset}>
      {children}
    </ErrorBoundary>
  );
}
