// Validated grid basket — the symbols that passed out-of-sample walk-forward
// validation (backtest_maxhold.py DEFAULT_BASKET). Autonomous grid deployment
// (AI advisor + portfolio rotator) is restricted to this allowlist so the bot
// stops auto-enabling unvalidated microcaps.
export const VALIDATED_SYMBOLS = new Set([
  "ENA_USDT", "HYPE_USDT", "XRP_USDT", "SOL_USDT", "WIF_USDT",
  "1000PEPE_USDT", "DOGE_USDT", "SUI_USDT", "BTC_USDT", "ETH_USDT",
  "LINK_USDT", "AVAX_USDT", "ARB_USDT", "OP_USDT", "TIA_USDT",
  "SEI_USDT", "INJ_USDT", "APT_USDT", "NEAR_USDT", "ATOM_USDT",
])
