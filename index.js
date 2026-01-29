// ============================================================================
// BINANCE FUTURES AGGRESSIVE FLOW MONITOR (STABLE VERSION)
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================================================
// BASE CONFIGURATION (READ-ONLY)
// ============================================================================

const CONFIG = {
  SYMBOL_CONFIGS: {
    'ADAUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'TAOUSDT': {
      minVolumeUSD: 1_500_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'HYPEUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 0.8,
      cooldownMinutes: 5,
      enabled: true
    },
    'PEPEUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'WIFUSDT': {
      minVolumeUSD: 1_500_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    },
    'BONKUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    },
    'DOGEUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 0.75,
      cooldownMinutes: 5,
      enabled: true
    },
    'XRPUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 1,
      cooldownMinutes: 5,
      enabled: true
    },
    'UNIUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    }
  },
  
  ADVANCED_FILTERS: {
    aggressionDecay: {
      enabled: true,
      lookbackMinutes: 3,
      decayThreshold: 0.85,
      minCandles: 2
    },
    
    stopCluster: {
      enabled: true,
      maxStops: 2,
      timeWindowMinutes: 30,
      pauseMinutes: 30
    },
    
    timeBased: {
      enabled: true,
      blockedDays: [],
      blockedHours: [],
      allowedHoursStart: 6,
      allowedHoursEnd: 18
    },
    
    btcVolatility: {
      enabled: true,
      checkIntervalMinutes: 5,
      thresholdPercent: 2.0,
      pauseMinutes: 15
    }
  },
  
  WINDOW_SECONDS: parseInt(process.env.WINDOW_SECONDS) || 180,
  MAX_RECONNECTS: parseInt(process.env.MAX_RECONNECTS) || 10,
  
  BINANCE_WS: 'wss://fstream.binance.com/ws',
  BINANCE_API: 'https://fapi.binance.com',
  
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  
  TRADING_BOT_ENABLED: process.env.TRADING_BOT_ENABLED === 'true' || false,
  ALERT_FORMAT: 'structured'
};

// ============================================================================
// RUNTIME STATE (SINGLE SOURCE OF TRUTH)
// ============================================================================

const runtimeState = {
  symbols: {},
  filters: {}
};

function initRuntimeState() {
  for (const [symbol, config] of Object.entries(CONFIG.SYMBOL_CONFIGS)) {
    runtimeState.symbols[symbol] = { ...config };
  }
  runtimeState.filters = JSON.parse(JSON.stringify(CONFIG.ADVANCED_FILTERS));
}

function getSymbolConfig(symbol) {
  return runtimeState.symbols[symbol] || null;
}

function getEnabledSymbols() {
  return Object.keys(runtimeState.symbols).filter(s => runtimeState.symbols[s].enabled);
}

function setSymbolParam(symbol, param, value) {
  if (!runtimeState.symbols[symbol]) {
    throw new Error(`Symbol ${symbol} not found`);
  }
  
  const validParams = ['minVolumeUSD', 'minDominance', 'minPriceChange', 'cooldownMinutes'];
  if (!validParams.includes(param)) {
    throw new Error(`Invalid parameter: ${param}`);
  }
  
  const numValue = parseFloat(value);
  if (isNaN(numValue)) {
    throw new Error(`Invalid value: ${value}`);
  }
  
  runtimeState.symbols[symbol][param] = numValue;
}

function enableSymbol(symbol) {
  if (!runtimeState.symbols[symbol]) {
    throw new Error(`Symbol ${symbol} not found`);
  }
  runtimeState.symbols[symbol].enabled = true;
}

function disableSymbol(symbol) {
  if (!runtimeState.symbols[symbol]) {
    throw new Error(`Symbol ${symbol} not found`);
  }
  runtimeState.symbols[symbol].enabled = false;
}

function getFilter(filterName) {
  return runtimeState.filters[filterName] || null;
}

function setFilterParam(filterName, param, value) {
  if (!runtimeState.filters[filterName]) {
    throw new Error(`Filter ${filterName} not found`);
  }
  
  if (param === 'enabled') {
    runtimeState.filters[filterName].enabled = value === 'true' || value === true;
  } else {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      throw new Error(`Invalid value: ${value}`);
    }
    runtimeState.filters[filterName][param] = numValue;
  }
}

// ============================================================================
// BTC VOLATILITY FILTER (SIMPLIFIED - ALERT ONLY)
// ============================================================================

class BTCVolatilityFilter {
  constructor(telegram) {
    this.telegram = telegram;
    this.paused = false;
    this.pauseUntil = 0;
    this.lastCheck = 0;
    this.alertCount = 0;
    this.lastPrice = null;
    this.currentPrice = null;
    this.checkInterval = null;
  }

  async start() {
    const filter = getFilter('btcVolatility');
    if (!filter.enabled) return;
    
    await this.checkVolatility();
    
    this.checkInterval = setInterval(() => {
      this.checkVolatility();
    }, filter.checkIntervalMinutes * 60 * 1000);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async checkVolatility() {
    const filter = getFilter('btcVolatility');
    if (!filter.enabled) return;

    try {
      const response = await axios.get(`${CONFIG.BINANCE_API}/fapi/v1/ticker/price?symbol=BTCUSDT`);
      this.currentPrice = parseFloat(response.data.price);
      
      if (this.lastPrice === null) {
        this.lastPrice = this.currentPrice;
        return;
      }
      
      const changePercent = Math.abs(((this.currentPrice - this.lastPrice) / this.lastPrice) * 100);
      
      if (changePercent >= filter.thresholdPercent) {
        this.paused = true;
        this.pauseUntil = Date.now() + (filter.pauseMinutes * 60 * 1000);
        this.alertCount++;
        
        const direction = this.currentPrice > this.lastPrice ? '📈' : '📉';
        
        console.log(`[BTC ALERT] Volatility detected: ${changePercent.toFixed(2)}% - PAUSING`);
        
        await this.telegram.sendMessage(
          CONFIG.TELEGRAM_CHAT_ID,
          `🚨 <b>BTC VOLATILITY ALERT</b>\n\n` +
          `${direction} <b>${changePercent.toFixed(2)}%</b> move detected\n` +
          `Price: $${this.currentPrice.toFixed(2)}\n\n` +
          `⏸ <b>Altcoin signals PAUSED for ${filter.pauseMinutes} minutes</b>`,
          { parse_mode: 'HTML' }
        );
      }
      
      this.lastPrice = this.currentPrice;
      
    } catch (error) {
      console.error('[BTC] Check error:', error.message);
    }
  }

  isPaused() {
    const filter = getFilter('btcVolatility');
    if (!filter.enabled) return false;
    
    if (this.paused && Date.now() >= this.pauseUntil) {
      this.paused = false;
      console.log('[BTC] Pause expired - resuming signals');
    }
    
    return this.paused;
  }

  getStatus() {
    const filter = getFilter('btcVolatility');
    const remainingMs = this.paused ? Math.max(0, this.pauseUntil - Date.now()) : 0;
    
    let currentVolatility = 0;
    if (this.lastPrice && this.currentPrice) {
      currentVolatility = Math.abs(((this.currentPrice - this.lastPrice) / this.lastPrice) * 100);
    }
    
    return {
      paused: this.paused,
      remainingMinutes: Math.ceil(remainingMs / 60000),
      currentVolatility: currentVolatility.toFixed(2),
      threshold: filter.thresholdPercent,
      btcPrice: this.currentPrice,
      alertCount: this.alertCount
    };
  }
}

// ============================================================================
// TIME-BASED FILTER
// ============================================================================

class TimeBasedFilter {
  isTradingAllowed() {
    const filter = getFilter('timeBased');
    if (!filter.enabled) {
      return { allowed: true, reason: 'Time filter disabled' };
    }

    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();

    if (filter.blockedDays.includes(dayOfWeek)) {
      return { 
        allowed: false, 
        reason: `Blocked day (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]})` 
      };
    }

    if (filter.blockedHours.includes(hour)) {
      return { allowed: false, reason: `Blocked hour (${hour}:00)` };
    }

    if (hour < filter.allowedHoursStart || hour >= filter.allowedHoursEnd) {
      return { 
        allowed: false, 
        reason: `Outside trading hours (${filter.allowedHoursStart}:00-${filter.allowedHoursEnd}:00)` 
      };
    }

    return { allowed: true, reason: 'Within trading hours' };
  }
}

// ============================================================================
// STOP CLUSTER PROTECTION
// ============================================================================

class StopClusterProtection {
  constructor() {
    this.stopEvents = [];
    this.paused = false;
    this.pauseUntil = 0;
  }

  recordStop(symbol) {
    const filter = getFilter('stopCluster');
    if (!filter.enabled) return;

    const now = Date.now();
    this.stopEvents.push({ symbol, timestamp: now });
    
    const windowMs = filter.timeWindowMinutes * 60 * 1000;
    this.stopEvents = this.stopEvents.filter(e => now - e.timestamp < windowMs);
    
    if (this.stopEvents.length >= filter.maxStops) {
      this.paused = true;
      this.pauseUntil = now + (filter.pauseMinutes * 60 * 1000);
      console.log(`[STOP CLUSTER] ${this.stopEvents.length} stops detected - PAUSING`);
    }
  }

  isPaused() {
    const filter = getFilter('stopCluster');
    if (!filter.enabled) return false;
    
    if (this.paused && Date.now() >= this.pauseUntil) {
      this.paused = false;
      this.stopEvents = [];
      console.log('[STOP CLUSTER] Pause expired - resuming');
    }
    
    return this.paused;
  }

  getStatus() {
    const filter = getFilter('stopCluster');
    const remainingMs = this.paused ? Math.max(0, this.pauseUntil - Date.now()) : 0;
    
    return {
      paused: this.paused,
      remainingMinutes: Math.ceil(remainingMs / 60000),
      recentStops: this.stopEvents.length,
      threshold: filter.maxStops
    };
  }
}

// ============================================================================
// AGGRESSION DECAY FILTER
// ============================================================================

class AggressionDecayFilter {
  constructor() {
    this.candleHistory = new Map();
  }

  recordCandle(symbol, candle) {
    const filter = getFilter('aggressionDecay');
    if (!filter.enabled) return;

    if (!this.candleHistory.has(symbol)) {
      this.candleHistory.set(symbol, []);
    }
    
    const history = this.candleHistory.get(symbol);
    history.push(candle);
    
    const maxCandles = filter.lookbackMinutes;
    if (history.length > maxCandles) {
      history.shift();
    }
  }

  checkDecay(symbol, currentDominance) {
    const filter = getFilter('aggressionDecay');
    if (!filter.enabled) return { passed: true, reason: 'Decay filter disabled' };

    const history = this.candleHistory.get(symbol) || [];
    
    if (history.length < filter.minCandles) {
      return { passed: true, reason: 'Insufficient history' };
    }

    const avgPastDominance = history.reduce((sum, c) => sum + c.dominance, 0) / history.length;
    const ratio = currentDominance / avgPastDominance;

    if (ratio < filter.decayThreshold) {
      return { 
        passed: false, 
        reason: `Aggression decay (${(ratio * 100).toFixed(1)}% < ${filter.decayThreshold * 100}%)` 
      };
    }

    return { passed: true, reason: 'No decay detected' };
  }

  reset(symbol) {
    this.candleHistory.delete(symbol);
  }
}

// ============================================================================
// TRADE AGGREGATOR
// ============================================================================

class TradeAggregator {
  constructor(windowSeconds) {
    this.windowSeconds = windowSeconds;
    this.trades = new Map();
    this.totalTradeCount = 0;
  }

  addTrade(symbol, trade) {
    if (!this.trades.has(symbol)) {
      this.trades.set(symbol, {
        buys: [],
        sells: [],
        lastUpdate: Date.now()
      });
    }

    const data = this.trades.get(symbol);
    const now = Date.now();
    const cutoff = now - (this.windowSeconds * 1000);

    if (trade.m) {
      data.sells.push({ price: trade.p, qty: trade.q, time: trade.T });
      data.sells = data.sells.filter(t => t.time > cutoff);
    } else {
      data.buys.push({ price: trade.p, qty: trade.q, time: trade.T });
      data.buys = data.buys.filter(t => t.time > cutoff);
    }

    data.lastUpdate = now;
    this.totalTradeCount++;
  }

  getStats(symbol) {
    const data = this.trades.get(symbol);
    if (!data) return null;

    const now = Date.now();
    const cutoff = now - (this.windowSeconds * 1000);

    const activeBuys = data.buys.filter(t => t.time > cutoff);
    const activeSells = data.sells.filter(t => t.time > cutoff);

    if (activeBuys.length === 0 && activeSells.length === 0) {
      return null;
    }

    const buyVolume = activeBuys.reduce((sum, t) => sum + (parseFloat(t.price) * parseFloat(t.qty)), 0);
    const sellVolume = activeSells.reduce((sum, t) => sum + (parseFloat(t.price) * parseFloat(t.qty)), 0);
    const totalVolume = buyVolume + sellVolume;

    if (totalVolume === 0) return null;

    const buyDominance = (buyVolume / totalVolume) * 100;
    const sellDominance = (sellVolume / totalVolume) * 100;

    const allPrices = [...activeBuys, ...activeSells].map(t => parseFloat(t.price));
    const maxPrice = Math.max(...allPrices);
    const minPrice = Math.min(...allPrices);
    const priceChange = ((maxPrice - minPrice) / minPrice) * 100;

    return {
      symbol,
      totalVolumeUSD: totalVolume,
      buyVolumeUSD: buyVolume,
      sellVolumeUSD: sellVolume,
      buyDominance,
      sellDominance,
      dominantSide: buyDominance > sellDominance ? 'BUY' : 'SELL',
      priceChange,
      tradeCount: activeBuys.length + activeSells.length,
      windowSeconds: this.windowSeconds
    };
  }

  resetSymbol(symbol) {
    this.trades.delete(symbol);
  }

  getActiveCount() {
    return this.trades.size;
  }

  getTotalTrades() {
    return this.totalTradeCount;
  }
}

// ============================================================================
// SIGNAL ENGINE
// ============================================================================

class SignalEngine {
  constructor(aggressionFilter, stopClusterFilter, timeFilter, btcFilter) {
    this.aggressionFilter = aggressionFilter;
    this.stopClusterFilter = stopClusterFilter;
    this.timeFilter = timeFilter;
    this.btcFilter = btcFilter;
  }

  checkSignal(stats) {
    const config = getSymbolConfig(stats.symbol);
    
    if (!config) {
      return { signal: false, reason: 'Symbol not found' };
    }

    if (!config.enabled) {
      return { signal: false, reason: 'Symbol disabled' };
    }

    if (this.btcFilter.isPaused()) {
      return { signal: false, reason: 'BTC volatility pause' };
    }

    if (this.stopClusterFilter.isPaused()) {
      return { signal: false, reason: 'Stop cluster pause' };
    }

    const timeCheck = this.timeFilter.isTradingAllowed();
    if (!timeCheck.allowed) {
      return { signal: false, reason: timeCheck.reason };
    }

    if (stats.totalVolumeUSD < config.minVolumeUSD) {
      return { signal: false, reason: 'Volume too low' };
    }

    const dominance = stats.dominantSide === 'BUY' ? stats.buyDominance : stats.sellDominance;
    if (dominance < config.minDominance) {
      return { signal: false, reason: 'Dominance too low' };
    }

    if (stats.priceChange < config.minPriceChange) {
      return { signal: false, reason: 'Price change too low' };
    }

    const decayCheck = this.aggressionFilter.checkDecay(stats.symbol, dominance);
    if (!decayCheck.passed) {
      return { signal: false, reason: decayCheck.reason };
    }

    return { signal: true, reason: 'All filters passed' };
  }
}

// ============================================================================
// COOLDOWN MANAGER
// ============================================================================

class CooldownManager {
  constructor() {
    this.cooldowns = new Map();
  }

  isInCooldown(symbol, side) {
    const key = `${symbol}_${side}`;
    const cooldownUntil = this.cooldowns.get(key);
    
    if (!cooldownUntil) return false;
    
    if (Date.now() < cooldownUntil) {
      return true;
    }
    
    this.cooldowns.delete(key);
    return false;
  }

  recordAlert(symbol, stats) {
    const config = getSymbolConfig(symbol);
    if (!config) return;
    
    const key = `${symbol}_${stats.dominantSide}`;
    const cooldownUntil = Date.now() + (config.cooldownMinutes * 60 * 1000);
    this.cooldowns.set(key, cooldownUntil);
  }

  getRemainingCooldown(symbol, side) {
    const key = `${symbol}_${side}`;
    const cooldownUntil = this.cooldowns.get(key);
    
    if (!cooldownUntil) return 0;
    
    const remaining = Math.max(0, cooldownUntil - Date.now());
    return Math.ceil(remaining / 1000);
  }
}

// ============================================================================
// ALERT MANAGER
// ============================================================================

class AlertManager {
  constructor(telegram, aggressionFilter) {
    this.telegram = telegram;
    this.aggressionFilter = aggressionFilter;
    this.alertCount = 0;
    this.pendingAlerts = 0;
  }

  async sendAlert(stats) {
    this.pendingAlerts++;
    
    try {
      const config = getSymbolConfig(stats.symbol);
      const side = stats.dominantSide === 'BUY' ? '🟢 LONG' : '🔴 SHORT';
      const emoji = stats.dominantSide === 'BUY' ? '📈' : '📉';
      
      const message = 
        `${emoji} <b>${side} SIGNAL</b>\n\n` +
        `<b>Symbol:</b> ${stats.symbol}\n` +
        `<b>Side:</b> ${stats.dominantSide}\n` +
        `<b>Dominance:</b> ${stats.dominantSide === 'BUY' ? stats.buyDominance.toFixed(1) : stats.sellDominance.toFixed(1)}%\n` +
        `<b>Volume:</b> $${(stats.totalVolumeUSD / 1e6).toFixed(2)}M\n` +
        `<b>Price Δ:</b> ${stats.priceChange.toFixed(2)}%\n` +
        `<b>Window:</b> ${stats.windowSeconds}s`;

      await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
      
      this.alertCount++;
      this.pendingAlerts--;
      
      this.aggressionFilter.recordCandle(stats.symbol, {
        timestamp: Date.now(),
        dominance: stats.dominantSide === 'BUY' ? stats.buyDominance : stats.sellDominance
      });
      
      console.log(`[ALERT SENT] ${stats.symbol} ${stats.dominantSide}`);
      
    } catch (error) {
      console.error('[ALERT ERROR]', error.message);
      this.pendingAlerts--;
    }
  }

  getCount() {
    return this.alertCount;
  }

  getPendingCount() {
    return this.pendingAlerts;
  }
}

// ============================================================================
// TELEGRAM COMMAND HANDLER
// ============================================================================

class TelegramCommandHandler {
  constructor(telegram, chatId, btcFilter) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.btcFilter = btcFilter;
  }

  async start() {
    this.telegram.onText(/\/help/, async (msg) => {
      const helpText = 
        `📱 <b>Available Commands</b>\n\n` +
        `<b>General:</b>\n` +
        `/status - Show filter status\n` +
        `/btc - BTC volatility info\n` +
        `/pause [minutes] - Pause all signals\n\n` +
        `<b>Configuration:</b>\n` +
        `/settings [symbol] - View symbol settings\n` +
        `/set [symbol] [param] [value] - Update parameter\n` +
        `/enable [symbol] - Enable symbol\n` +
        `/disable [symbol] - Disable symbol\n\n` +
        `<b>Filters:</b>\n` +
        `/filters - View all filters\n` +
        `/filter [name] [param] [value] - Update filter`;
      
      await this.telegram.sendMessage(this.chatId, helpText, { parse_mode: 'HTML' });
    });

    this.telegram.onText(/\/settings(?:\s+(\w+))?/, async (msg, match) => {
      const symbol = match[1] ? match[1].toUpperCase() : null;
      
      if (symbol) {
        const config = getSymbolConfig(symbol);
        if (!config) {
          await this.telegram.sendMessage(this.chatId, `❌ Symbol ${symbol} not found`);
          return;
        }
        
        const text = 
          `⚙️ <b>${symbol} Settings</b>\n\n` +
          `Status: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `Min Volume: $${(config.minVolumeUSD / 1e6).toFixed(1)}M\n` +
          `Min Dominance: ${config.minDominance}%\n` +
          `Min Price Change: ${config.minPriceChange}%\n` +
          `Cooldown: ${config.cooldownMinutes} min`;
        
        await this.telegram.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
      } else {
        const symbols = Object.keys(runtimeState.symbols);
        const lines = symbols.map(s => {
          const c = runtimeState.symbols[s];
          return `${c.enabled ? '✅' : '❌'} ${s}: $${(c.minVolumeUSD/1e6).toFixed(1)}M | ${c.minDominance}% | ${c.minPriceChange}%`;
        });
        
        await this.telegram.sendMessage(
          this.chatId,
          `⚙️ <b>All Symbol Settings</b>\n\n${lines.join('\n')}`,
          { parse_mode: 'HTML' }
        );
      }
    });

    this.telegram.onText(/\/set\s+(\w+)\s+(\w+)\s+([\d.]+)/, async (msg, match) => {
      try {
        const symbol = match[1].toUpperCase();
        const param = match[2];
        const value = match[3];
        
        setSymbolParam(symbol, param, value);
        
        await this.telegram.sendMessage(
          this.chatId,
          `✅ Updated ${symbol}.${param} = ${value}`
        );
      } catch (error) {
        await this.telegram.sendMessage(this.chatId, `❌ ${error.message}`);
      }
    });

    this.telegram.onText(/\/enable\s+(\w+)/, async (msg, match) => {
      try {
        const symbol = match[1].toUpperCase();
        enableSymbol(symbol);
        await this.telegram.sendMessage(this.chatId, `✅ ${symbol} enabled`);
      } catch (error) {
        await this.telegram.sendMessage(this.chatId, `❌ ${error.message}`);
      }
    });

    this.telegram.onText(/\/disable\s+(\w+)/, async (msg, match) => {
      try {
        const symbol = match[1].toUpperCase();
        disableSymbol(symbol);
        await this.telegram.sendMessage(this.chatId, `❌ ${symbol} disabled`);
      } catch (error) {
        await this.telegram.sendMessage(this.chatId, `❌ ${error.message}`);
      }
    });

    this.telegram.onText(/\/filters/, async (msg) => {
      const filters = runtimeState.filters;
      
      const text = 
        `🎯 <b>Advanced Filters</b>\n\n` +
        `<b>Aggression Decay:</b> ${filters.aggressionDecay.enabled ? '✅' : '❌'}\n` +
        `  Lookback: ${filters.aggressionDecay.lookbackMinutes} min\n` +
        `  Threshold: ${(filters.aggressionDecay.decayThreshold * 100).toFixed(0)}%\n\n` +
        `<b>Stop Cluster:</b> ${filters.stopCluster.enabled ? '✅' : '❌'}\n` +
        `  Max stops: ${filters.stopCluster.maxStops}\n` +
        `  Window: ${filters.stopCluster.timeWindowMinutes} min\n` +
        `  Pause: ${filters.stopCluster.pauseMinutes} min\n\n` +
        `<b>Time-Based:</b> ${filters.timeBased.enabled ? '✅' : '❌'}\n` +
        `  Hours: ${filters.timeBased.allowedHoursStart}-${filters.timeBased.allowedHoursEnd}\n\n` +
        `<b>BTC Volatility:</b> ${filters.btcVolatility.enabled ? '✅' : '❌'}\n` +
        `  Check interval: ${filters.btcVolatility.checkIntervalMinutes} min\n` +
        `  Threshold: ${filters.btcVolatility.thresholdPercent}%\n` +
        `  Pause: ${filters.btcVolatility.pauseMinutes} min`;
      
      await this.telegram.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
    });

    this.telegram.onText(/\/filter\s+(\w+)\s+(\w+)\s+(.+)/, async (msg, match) => {
      try {
        const filterName = match[1];
        const param = match[2];
        const value = match[3];
        
        setFilterParam(filterName, param, value);
        
        await this.telegram.sendMessage(
          this.chatId,
          `✅ Updated ${filterName}.${param} = ${value}`
        );
      } catch (error) {
        await this.telegram.sendMessage(this.chatId, `❌ ${error.message}`);
      }
    });

    this.telegram.onText(/\/btc/, async (msg) => {
      const status = this.btcFilter.getStatus();
      
      const text = 
        `₿ <b>BTC Volatility Monitor</b>\n\n` +
        `Status: ${status.paused ? '⏸ PAUSED' : '✅ ACTIVE'}\n` +
        `${status.paused ? `Remaining: ${status.remainingMinutes} min\n` : ''}` +
        `Current volatility: ${status.currentVolatility}%\n` +
        `Threshold: ${status.threshold}%\n` +
        `${status.btcPrice ? `BTC Price: $${status.btcPrice.toFixed(2)}\n` : ''}` +
        `Alerts sent: ${status.alertCount}`;
      
      await this.telegram.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
    });

    this.telegram.onText(/\/pause(?:\s+(\d+))?/, async (msg, match) => {
      const minutes = match[1] ? parseInt(match[1]) : 60;
      
      this.btcFilter.paused = true;
      this.btcFilter.pauseUntil = Date.now() + (minutes * 60 * 1000);
      
      console.log(`[MANUAL PAUSE] ${minutes} minutes`);
      
      await this.telegram.sendMessage(
        this.chatId,
        `⏸ All signals paused for ${minutes} minutes`
      );
    });
  }
}

// ============================================================================
// WEBSOCKET MANAGER
// ============================================================================

class MultiWebSocketManager {
  constructor(symbols, tradeAggregator, signalEngine, cooldownManager, alertManager) {
    this.symbols = symbols;
    this.tradeAggregator = tradeAggregator;
    this.signalEngine = signalEngine;
    this.cooldownManager = cooldownManager;
    this.alertManager = alertManager;
    
    this.connections = new Map();
    this.reconnectAttempts = new Map();
    this.lastMinuteCheck = new Map();
  }

  connectAll() {
    for (const symbol of this.symbols) {
      this.connectSymbol(symbol);
    }
  }

  connectSymbol(symbol) {
    const streamName = `${symbol.toLowerCase()}@aggTrade`;
    const ws = new WebSocket(`${CONFIG.BINANCE_WS}/${streamName}`);
    
    ws.on('open', () => {
      this.reconnectAttempts.set(symbol, 0);
    });

    ws.on('message', (data) => {
      this.handleMessage(symbol, data);
    });

    ws.on('error', (error) => {
      console.error(`[WS ERROR] ${symbol}:`, error.message);
    });

    ws.on('close', () => {
      this.connections.delete(symbol);
      this.reconnectSymbol(symbol);
    });

    this.connections.set(symbol, ws);
  }

  handleMessage(symbol, data) {
    try {
      const trade = JSON.parse(data);
      
      this.tradeAggregator.addTrade(symbol, trade);
      
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const lastChecked = this.lastMinuteCheck.get(symbol) || 0;
      
      if (currentMinute > lastChecked) {
        this.lastMinuteCheck.set(symbol, currentMinute);
        
        const stats = this.tradeAggregator.getStats(symbol);
        
        if (stats) {
          const signalCheck = this.signalEngine.checkSignal(stats);
          
          if (signalCheck.signal) {
            if (!this.cooldownManager.isInCooldown(symbol, stats.dominantSide)) {
              this.alertManager.sendAlert(stats);
              this.cooldownManager.recordAlert(symbol, stats);
              this.tradeAggregator.resetSymbol(symbol);
            }
          }
        }
      }
      
    } catch (error) {
      console.error(`[WS] ${symbol} parse error:`, error.message);
    }
  }

  reconnectSymbol(symbol) {
    const attempts = this.reconnectAttempts.get(symbol) || 0;
    
    if (attempts >= CONFIG.MAX_RECONNECTS) {
      console.error(`[WS] ${symbol} max reconnects reached`);
      return;
    }

    this.reconnectAttempts.set(symbol, attempts + 1);
    
    setTimeout(() => {
      this.connectSymbol(symbol);
    }, 5000 * (attempts + 1));
  }

  closeAll() {
    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();
  }
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

class BinanceFuturesFlowBot {
  constructor() {
    initRuntimeState();
    
    this.aggressionFilter = new AggressionDecayFilter();
    this.stopClusterFilter = new StopClusterProtection();
    this.timeFilter = new TimeBasedFilter();
    
    this.telegram = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
    
    this.btcFilter = new BTCVolatilityFilter(this.telegram);
    
    this.tradeAggregator = new TradeAggregator(CONFIG.WINDOW_SECONDS);
    this.signalEngine = new SignalEngine(
      this.aggressionFilter,
      this.stopClusterFilter,
      this.timeFilter,
      this.btcFilter
    );
    this.cooldownManager = new CooldownManager();
    this.alertManager = new AlertManager(this.telegram, this.aggressionFilter);
    this.wsManager = null;
    this.commandHandler = null;

    this.setupStatusCommand();
  }

  setupStatusCommand() {
    this.telegram.onText(/\/status/, async (msg) => {
      try {
        const stopStatus = this.stopClusterFilter.getStatus();
        const btcStatus = this.btcFilter.getStatus();
        const timeCheck = this.timeFilter.isTradingAllowed();

        const lines = ['📊 <b>Live Filter Status</b>\n'];
        
        lines.push(`🛑 <b>Stop Cluster:</b> ${stopStatus.paused ? '⏸ PAUSED' : '✅ ACTIVE'}`);
        if (stopStatus.paused) {
          lines.push(`   Remaining: ${stopStatus.remainingMinutes} min`);
        }
        lines.push(`   Recent stops: ${stopStatus.recentStops}/${stopStatus.threshold}`);
        lines.push('');
        
        lines.push(`₿ <b>BTC Filter:</b> ${btcStatus.paused ? '⏸ PAUSED' : '✅ ACTIVE'}`);
        if (btcStatus.paused) {
          lines.push(`   Remaining: ${btcStatus.remainingMinutes} min`);
        }
        lines.push(`   Current volatility: ${btcStatus.currentVolatility}%`);
        lines.push(`   Threshold: ${btcStatus.threshold}%`);
        if (btcStatus.btcPrice) {
          lines.push(`   BTC Price: $${btcStatus.btcPrice.toFixed(2)}`);
        }
        lines.push(`   BTC Alerts: ${btcStatus.alertCount}`);
        lines.push('');
        
        lines.push(`⏰ <b>Time Filter:</b> ${timeCheck.allowed ? '✅ ALLOWED' : '⛔ BLOCKED'}`);
        lines.push(`   ${timeCheck.reason}`);
        lines.push('');
        
        const agConfig = getFilter('aggressionDecay');
        lines.push(`⚡ <b>Aggression Decay:</b> ${agConfig.enabled ? '✅ ON' : '🔴 OFF'}`);
        
        lines.push('\n━━━━━━━━━━━━━━━━━');
        lines.push(`Alerts sent: ${this.alertManager.getCount()}`);
        lines.push(`Pending: ${this.alertManager.getPendingCount()}`);

        await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, lines.join('\n'), { parse_mode: 'HTML' });
      } catch (error) {
        console.error('[STATUS ERROR]', error.message);
      }
    });
  }

  async start() {
    const symbols = getEnabledSymbols();
    
    console.log('='.repeat(70));
    console.log('BINANCE FUTURES AGGRESSIVE FLOW MONITOR');
    console.log('='.repeat(70));
    console.log(`Symbols: ${symbols.length} | Window: ${CONFIG.WINDOW_SECONDS}s`);
    console.log('='.repeat(70));

    await this.btcFilter.start();

    this.commandHandler = new TelegramCommandHandler(
      this.telegram,
      CONFIG.TELEGRAM_CHAT_ID,
      this.btcFilter
    );
    await this.commandHandler.start();

    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        `🚀 <b>Binance Futures Monitor Started</b>\n\n` +
        `Monitoring ${symbols.length} symbols\n` +
        `Commands: /help | /status | /btc | /filters`,
        { parse_mode: 'HTML' }
      );
      console.log('[TELEGRAM] ✅ Connected\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Error:', error.message);
      process.exit(1);
    }

    this.wsManager = new MultiWebSocketManager(
      symbols,
      this.tradeAggregator,
      this.signalEngine,
      this.cooldownManager,
      this.alertManager
    );
    
    this.wsManager.connectAll();

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Stopping...');
    
    if (this.wsManager) {
      this.wsManager.closeAll();
    }

    if (this.btcFilter) {
      this.btcFilter.stop();
    }
    
    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '⛔ Binance Futures Monitor Stopped'
    );
    
    this.telegram.stopPolling();
    process.exit(0);
  }
}

// ============================================================================
// STARTUP
// ============================================================================

if (require.main === module) {
  const bot = new BinanceFuturesFlowBot();
  bot.start().catch(error => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}

module.exports = { BinanceFuturesFlowBot };
