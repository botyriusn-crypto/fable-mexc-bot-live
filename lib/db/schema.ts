import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core"

export const botConfig = pgTable("bot_config", {
  id: integer("id").primaryKey().default(1),
  symbol: text("symbol").notNull().default("BTC_USDT"),
  timeframe: text("timeframe").notNull().default("Min5"),
  emaFast: integer("ema_fast").notNull().default(9),
  emaSlow: integer("ema_slow").notNull().default(21),
  rsiPeriod: integer("rsi_period").notNull().default(14),
  rsiOverbought: doublePrecision("rsi_overbought").notNull().default(70),
  rsiOversold: doublePrecision("rsi_oversold").notNull().default(30),
  atrPeriod: integer("atr_period").notNull().default(14),
  strategyMode: text("strategy_mode").notNull().default("auto"), // 'auto' | 'trend' | 'range'
  adxTrendThreshold: doublePrecision("adx_trend_threshold").notNull().default(25),
  adxRangeThreshold: doublePrecision("adx_range_threshold").notNull().default(20),
  bbPeriod: integer("bb_period").notNull().default(20),
  bbStd: doublePrecision("bb_std").notNull().default(2),
  slAtrMult: doublePrecision("sl_atr_mult").notNull().default(1.5),
  tpAtrMult: doublePrecision("tp_atr_mult").notNull().default(2.5),
  trailAtrMult: doublePrecision("trail_atr_mult").notNull().default(1.2),
  momentumThreshold: doublePrecision("momentum_threshold").notNull().default(0.6),
  mlConfidenceThreshold: doublePrecision("ml_confidence_threshold").notNull().default(0.55),
  mlLearningRate: doublePrecision("ml_learning_rate").notNull().default(0.05),
  confirmationMode: text("confirmation_mode").notNull().default("observe"), // 'observe' | 'logistic' | 'lorentzian' | 'both'
  lorentzianConfidenceThreshold: doublePrecision("lorentzian_confidence_threshold").notNull().default(0.25),
  lorentzianNeighbors: integer("lorentzian_neighbors").notNull().default(8),
  lorentzianLookback: integer("lorentzian_lookback").notNull().default(500),
  lorentzianUseVolatilityFilter: boolean("lorentzian_use_volatility_filter").notNull().default(true),
  lorentzianUseRegimeFilter: boolean("lorentzian_use_regime_filter").notNull().default(true),
  lorentzianUseAdxFilter: boolean("lorentzian_use_adx_filter").notNull().default(false),
  lorentzianRegimeThreshold: doublePrecision("lorentzian_regime_threshold").notNull().default(-0.1),
  lorentzianAdxThreshold: integer("lorentzian_adx_threshold").notNull().default(20),
  lorentzianKernelFilter: boolean("lorentzian_kernel_filter").notNull().default(true),
  lorentzianWebhooks: boolean("lorentzian_webhooks").notNull().default(false),
  leverage: integer("leverage").notNull().default(5),
  positionSizeUsdt: doublePrecision("position_size_usdt").notNull().default(500),
  allowLong: boolean("allow_long").notNull().default(true),
  allowShort: boolean("allow_short").notNull().default(true),
  gridEnabled: boolean("grid_enabled").notNull().default(false),
  gridLevels: integer("grid_levels").notNull().default(10),
  gridRangeAtrMult: doublePrecision("grid_range_atr_mult").notNull().default(2),
  gridBudgetPct: doublePrecision("grid_budget_pct").notNull().default(30),
  gridLeverage: integer("grid_leverage").notNull().default(2),
  gridAutoPause: boolean("grid_auto_pause").notNull().default(true),
  gridPaused: boolean("grid_paused").notNull().default(false),
  gridFeeMarginMult: doublePrecision("grid_fee_margin_mult").notNull().default(3),
  gridCenter: doublePrecision("grid_center"),
  gridLower: doublePrecision("grid_lower"),
  gridUpper: doublePrecision("grid_upper"),
  gridSpacing: doublePrecision("grid_spacing"),
  gridEffectiveLevels: integer("grid_effective_levels"),
  exchange: text("exchange").notNull().default("mexc"),
  aiAdvisorEnabled: boolean("ai_advisor_enabled").notNull().default(false),
  aiAnalysisSchedule: text("ai_analysis_schedule").notNull().default("manual"),
  aiLastAnalysis: timestamp("ai_last_analysis", { withTimezone: true }),
  swingEnabled: boolean("swing_enabled").notNull().default(false),
  swingRiskPct: doublePrecision("swing_risk_pct").notNull().default(0.02),
  swingSymbols: jsonb("swing_symbols").notNull().default('["BTC_USDT","ETH_USDT"]'),
  swingLeverage: integer("swing_leverage").notNull().default(1),
  sniperLive: boolean("sniper_live").notNull().default(false),
  sniperMaxEntries: integer("sniper_max_entries").notNull().default(3),
  sniperPositionSizeUsdt: doublePrecision("sniper_position_size_usdt").notNull().default(50),
  sniperLeverage: integer("sniper_leverage").notNull().default(3),
  sniperConfidenceFloor: doublePrecision("sniper_confidence_floor").notNull().default(0.6),
  sniperCorrThreshold: doublePrecision("sniper_corr_threshold").notNull().default(0.8),
  sniperSigmaExtreme: doublePrecision("sniper_sigma_extreme").notNull().default(3.5),
  sniperVolumeSurgeMult: doublePrecision("sniper_volume_surge_mult").notNull().default(2.0),
  sniperMinVolumeUsdt: doublePrecision("sniper_min_volume_usdt").notNull().default(1000000),
  sniperTargetRiskUsdt: doublePrecision("sniper_target_risk_usdt").notNull().default(5),
  sniperMinStopPct: doublePrecision("sniper_min_stop_pct").notNull().default(0.008),
  sniperTpSlRatio: doublePrecision("sniper_tp_sl_ratio").notNull().default(4.0),
  sniperMomentumThreshold: doublePrecision("sniper_momentum_threshold").notNull().default(0.7),
  sniperTrailAtrMult: doublePrecision("sniper_trail_atr_mult").notNull().default(0.6),
  // Partial profit taking
  partialTakeEnabled: boolean("partial_take_enabled").notNull().default(false),
  partialFraction: doublePrecision("partial_fraction").notNull().default(0.5),
  partialAtrMult: doublePrecision("partial_atr_mult").notNull().default(1.0),
  // Advanced strategy
  advancedEnabled: boolean("advanced_enabled").notNull().default(false),
  advancedMtfEnabled: boolean("advanced_mtf_enabled").notNull().default(true),
  advancedHtfTimeframe: text("advanced_htf_timeframe").notNull().default("Min60"),
  advancedHtfEmaFast: integer("advanced_htf_ema_fast").notNull().default(9),
  advancedHtfEmaSlow: integer("advanced_htf_ema_slow").notNull().default(21),
  advancedMtfMinAlignment: doublePrecision("advanced_mtf_min_alignment").notNull().default(0.66),
  advancedSmartMoneyEnabled: boolean("advanced_smart_money_enabled").notNull().default(true),
  advancedFundingLongThreshold: doublePrecision("advanced_funding_long_threshold").notNull().default(-0.0005),
  advancedFundingShortThreshold: doublePrecision("advanced_funding_short_threshold").notNull().default(0.0005),
  advancedOiDeltaThresholdPct: doublePrecision("advanced_oi_delta_threshold_pct").notNull().default(2),
  advancedCvdZThreshold: doublePrecision("advanced_cvd_z_threshold").notNull().default(1.5),
  advancedDynamicSizingEnabled: boolean("advanced_dynamic_sizing_enabled").notNull().default(true),
  advancedBaseRiskPct: doublePrecision("advanced_base_risk_pct").notNull().default(0.01),
  advancedMaxRiskPct: doublePrecision("advanced_max_risk_pct").notNull().default(0.02),
  advancedConfidenceFloor: doublePrecision("advanced_confidence_floor").notNull().default(0.5),
  advancedMaxPositionPct: doublePrecision("advanced_max_position_pct").notNull().default(0.25),
  // Trend Rider strategy (4H detection + 15m entry + daily regime gate)
  trendRiderEnabled: boolean("trend_rider_enabled").notNull().default(false),
  trendRiderPositionSizeUsdt: doublePrecision("trend_rider_position_size_usdt").notNull().default(500),
  trendRiderLeverage: integer("trend_rider_leverage").notNull().default(3),
  trendRiderPullbackAtr: doublePrecision("trend_rider_pullback_atr").notNull().default(0.3),
  trendRiderMinTrendAge: integer("trend_rider_min_trend_age").notNull().default(3),
  trendRiderChandelierMult: doublePrecision("trend_rider_chandelier_mult").notNull().default(3.0),
  trendRiderRegimeGate: boolean("trend_rider_regime_gate").notNull().default(true),
  trendRiderRegimeAdxMin: integer("trend_rider_regime_adx_min").notNull().default(20),
trendRiderHtfTrailUseSwing: boolean("trend_rider_htf_trail_use_swing").notNull().default(true),
  mode: text("mode").notNull().default("paper"),
  status: text("status").notNull().default("stopped"),
  paperBalance: doublePrecision("paper_balance").notNull().default(10000),
  paperStartingBalance: doublePrecision("paper_starting_balance").notNull().default(10000),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("Min5"),
  side: text("side").notNull(), // 'long' | 'short'
  entryPrice: doublePrecision("entry_price").notNull(),
  sizeUsdt: doublePrecision("size_usdt").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  leverage: integer("leverage").notNull(),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),
  trailingStop: doublePrecision("trailing_stop"),
  trailingActive: boolean("trailing_active").notNull().default(false),
  breakEvenMoved: boolean("break_even_moved").notNull().default(false),
  highestPrice: doublePrecision("highest_price"),
  lowestPrice: doublePrecision("lowest_price"),
  entryConfidence: doublePrecision("entry_confidence"),
  entryFeatures: jsonb("entry_features"),
  atrAtEntry: doublePrecision("atr_at_entry"),
  strategy: text("strategy").notNull().default("trend"), // 'trend' | 'range' | 'webhook'
  rangeTarget: doublePrecision("range_target"), // mean-reversion TP (BB middle at entry)
  remainingQuantity: doublePrecision("remaining_quantity"),
  partialExitCount: integer("partial_exit_count").notNull().default(0),
  status: text("status").notNull().default("open"), // 'open' | 'closed'
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
})

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  positionId: integer("position_id"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  exitPrice: doublePrecision("exit_price").notNull(),
  sizeUsdt: doublePrecision("size_usdt").notNull(),
  leverage: integer("leverage").notNull(),
  pnl: doublePrecision("pnl").notNull(),
  fees: doublePrecision("fees").notNull(),
  exitReason: text("exit_reason").notNull(), // 'tp' | 'sl' | 'trail' | 'signal' | 'manual' | 'partial'
  strategy: text("strategy").notNull().default("trend"), // 'trend' | 'range' | 'webhook'
  entryConfidence: doublePrecision("entry_confidence"),
  partial: boolean("partial").notNull().default(false),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  live: boolean("live").notNull().default(false),
})

export const equitySnapshots = pgTable("equity_snapshots", {
  id: serial("id").primaryKey(),
  balance: doublePrecision("balance").notNull(),
  equity: doublePrecision("equity").notNull(),
  unrealizedPnl: doublePrecision("unrealized_pnl").notNull().default(0),
  live: boolean("live").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const botLogs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"), // 'info' | 'trade' | 'error'
  message: text("message").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const mlModel = pgTable("ml_model", {
  id: integer("id").primaryKey().default(1),
  weights: jsonb("weights").notNull().$type<Record<string, number>>(),
  bias: doublePrecision("bias").notNull().default(0),
  sampleCount: integer("sample_count").notNull().default(0),
  correctCount: integer("correct_count").notNull().default(0),
  rollingAccuracy: doublePrecision("rolling_accuracy").notNull().default(0.5),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const tradeFeatures = pgTable("trade_features", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id"),
  positionId: integer("position_id"),
  features: jsonb("features").notNull().$type<Record<string, number>>(),
  label: doublePrecision("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const classifierDecisions = pgTable("classifier_decisions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  candleTime: integer("candle_time").notNull(),
  candidateDirection: text("candidate_direction").notNull(),
  strategy: text("strategy").notNull(),
  regime: text("regime").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  confirmationMode: text("confirmation_mode").notNull(),
  logisticAllowed: boolean("logistic_allowed").notNull(),
  logisticConfidence: doublePrecision("logistic_confidence").notNull(),
  lorentzianDirection: text("lorentzian_direction").notNull(),
  lorentzianVote: integer("lorentzian_vote").notNull(),
  lorentzianConfidence: doublePrecision("lorentzian_confidence").notNull(),
  lorentzianAllowed: boolean("lorentzian_allowed").notNull(),
  lorentzianFilters: jsonb("lorentzian_filters"),
  finalAllowed: boolean("final_allowed").notNull(),
  reason: text("reason").notNull(),
  outcomeDirection: text("outcome_direction"),
  outcomeReturn: doublePrecision("outcome_return"),
  outcomeCorrectLogistic: boolean("outcome_correct_logistic"),
  outcomeCorrectLorentzian: boolean("outcome_correct_lorentzian"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const aiRecommendations = pgTable("ai_recommendations", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  analysisAt: timestamp("analysis_at", { withTimezone: true }).notNull().defaultNow(),
  tradeCount: integer("trade_count").notNull(),
  avgReturn: doublePrecision("avg_return").notNull(),
  winRate: doublePrecision("win_rate").notNull(),
  currentSettings: jsonb("current_settings").notNull(),
  recommendations: jsonb("recommendations").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'applied' | 'rejected'
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const gridOrders = pgTable("grid_orders", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().default("BTC_USDT"),
  timeframe: text("timeframe").notNull().default("Min5"),
  leverage: integer("leverage").notNull().default(2),
  spacing: doublePrecision("spacing"),
  levelIndex: integer("level_index").notNull(),
  side: text("side").notNull(), // 'buy' | 'sell'
  price: doublePrecision("price").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  buyPrice: doublePrecision("buy_price"), // for sell orders: the paired buy entry price
  entryFeatures: jsonb("entry_features").$type<Record<string, number>>(),
  status: text("status").notNull().default("pending"), // 'pending' | 'filled' | 'cancelled'
  mexcOrderId: text("mexc_order_id"),
  exchangeStatus: text("exchange_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  filledAt: timestamp("filled_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
})


export const gridConfigs = pgTable("grid_configs", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().default("BTC_USDT"),
  timeframe: text("timeframe").notNull().default("Min15"),
  enabled: boolean("enabled").notNull().default(true),
  levels: integer("levels").notNull().default(5),
  rangeAtrMult: doublePrecision("range_atr_mult").notNull().default(0.5),
  budgetPct: doublePrecision("budget_pct").notNull().default(30),
  leverage: integer("leverage").notNull().default(2),
  feeMarginMult: doublePrecision("fee_margin_mult").notNull().default(3),
  autoPause: boolean("auto_pause").notNull().default(true),
  paused: boolean("paused").notNull().default(false),
  makerMode: boolean("maker_mode").notNull().default(false),
  direction: text("direction").notNull().default("long"),
  center: doublePrecision("center"),
  lower: doublePrecision("lower"),
  upper: doublePrecision("upper"),
  spacing: doublePrecision("spacing"),
  effectiveLevels: integer("effective_levels"),
  // Free-form metadata (e.g. new-listing tracking: isNewListing, detectedAt, ttlHours).
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})


export const advisorVariants = pgTable("advisor_variants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  params: jsonb("params").notNull(),
  stats: jsonb("stats").notNull().default({ allowed: 0, correct: 0, sumReturn: 0 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type BotConfig = typeof botConfig.$inferSelect
export type GridConfigRow = typeof gridConfigs.$inferSelect
export type GridOrder = typeof gridOrders.$inferSelect
export type Position = typeof positions.$inferSelect
export type Trade = typeof trades.$inferSelect
export type MlModelRow = typeof mlModel.$inferSelect
export type AiRecommendation = typeof aiRecommendations.$inferSelect
