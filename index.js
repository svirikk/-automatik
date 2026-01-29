// ============================================================================
// BINANCE FUTURES AGGRESSIVE FLOW MONITOR (MVP Enhanced Version)
// + Entry Timing Optimization
// + Stop Cluster Protection
// + Time-Based Filters
// + BTC Volatility Kill-Switch (Simplified - Alert-Based)
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================================================
// BASE CONFIGURATION
// ============================================================================

const CONFIG = {
  // Individual symbol configurations
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
  
  // Advanced Filter Settings (MVP)
  ADVANCED_FILTERS: {
    // 1. Aggression Decay Filter
    aggressionDecay: {
      enabled: true,
      lookbackMinutes: 3,
      decayThreshold: 0.85,
      minCandles: 2
    },
    
    // 2. Stop Cluster Protection
    stopCluster: {
      enabled: true,
      maxStops: 2,
      timeWindowMinutes: 30,
      pauseMinutes: 30
    },
    
    // 3. Time-Based Filters
    timeBased: {
      enabled: true,
      blockedDays: [],
      blockedHours: [],
      allowedHoursStart: 6,
      allowedHoursEnd: 18
    },
    
    // 4. BTC Volatility Kill-Switch (Simplified)
    btcVolatility: {
      enabled: true,
      checkIntervalMinutes: 1,     // Перевірка кожну хвилину
      timeframeMinutes: 10,         // Аналізувати останні 10 хв
      thresholdPercent: 2.0,        // % руху для тригера
      pauseMinutes: 15              // Пауза після алерту
    }
  },
  
  // Time window for aggregation
  WINDOW_SECONDS: parseInt(process.env.WINDOW_SECONDS) || 180,
  
  // System
  STATS_LOG_INTERVAL: parseInt(process.env.STATS_LOG_INTERVAL) || 60,
  MAX_RECONNECTS: parseInt(process.env.MAX_RECONNECTS) || 10,
  
  // Binance API
  BINANCE_WS: 'wss://fstream.binance.com/ws',
  BINANCE_API: 'https://fapi.binance.com',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  
  // Trading bot integration
  TRADING_BOT_ENABLED: process.env.TRADING_BOT_ENABLED === 'true' || false,
  ALERT_FORMAT: 'structured'
};

// ============================================================================
// RUNTIME CONFIGURATION MANAGER (Extended)
// ============================================================================

class RuntimeConfig {
  constructor(initialConfig, advancedFilters) {
    this.symbolConfigs = {};
    for (const [symbol, config] of Object.entries(initialConfig)) {
      this.symbolConfigs[symbol] = { ...config };
    }
    
    this.advancedFilters = JSON.parse(JSON.stringify(advancedFilters));
  }

  get(symbol) {
    return this.symbolConfigs[symbol] || null;
  }

  getEnabledSymbols() {
    return Object.keys(this.symbolConfigs).filter(
      symbol => this.symbolConfigs[symbol].enabled
    );
  }

  getAllSymbols() {
    return Object.keys(this.symbolConfigs);
  }

  set(symbol, param, value) {
    if (!this.symbolConfigs[symbol]) {
      throw new Error(`Symbol ${symbol} not found`);
    }

    const validParams = ['minVolumeUSD', 'minDominance', 'minPriceChange', 'cooldownMinutes'];
    if (!validParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}. Valid: ${validParams.join(', ')}`);
    }

    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      throw new Error(`Invalid value: ${value} (must be a number)`);
    }

    if (param === 'minVolumeUSD' && numValue < 0) {
      throw new Error('minVolumeUSD must be >= 0');
    }
    if (param === 'minDominance' && (numValue < 50 || numValue > 100)) {
      throw new Error('minDominance must be between 50 and 100');
    }
    if (param === 'minPriceChange' && numValue < 0) {
      throw new Error('minPriceChange must be >= 0');
    }
    if (param === 'cooldownMinutes' && numValue < 0) {
      throw new Error('cooldownMinutes must be >= 0');
    }

    const oldValue = this.symbolConfigs[symbol][param];
    this.symbolConfigs[symbol][param] = numValue;

    console.log(`[CONFIG] ${symbol}.${param}: ${oldValue} → ${numValue}`);
    return { oldValue, newValue: numValue };
  }

  enable(symbol) {
    if (!this.symbolConfigs[symbol]) {
      throw new Error(`Symbol ${symbol} not found`);
    }
    this.symbolConfigs[symbol].enabled = true;
    console.log(`[CONFIG] ${symbol} ENABLED`);
  }

  disable(symbol) {
    if (!this.symbolConfigs[symbol]) {
      throw new Error(`Symbol ${symbol} not found`);
    }
    this.symbolConfigs[symbol].enabled = false;
    console.log(`[CONFIG] ${symbol} DISABLED`);
  }

  format(symbol) {
    const config = this.symbolConfigs[symbol];
    if (!config) return null;

    return {
      symbol,
      enabled: config.enabled,
      minVolumeUSD: config.minVolumeUSD,
      minDominance: config.minDominance,
      minPriceChange: config.minPriceChange,
      cooldownMinutes: config.cooldownMinutes
    };
  }

  getFilter(filterName) {
    return this.advancedFilters[filterName] || null;
  }

  setFilterParam(filterName, param, value) {
    if (!this.advancedFilters[filterName]) {
      throw new Error(`Filter ${filterName} not found`);
    }

    if (param === 'enabled') {
      const boolValue = value === 'true' || value === true;
      this.advancedFilters[filterName].enabled = boolValue;
      console.log(`[FILTER] ${filterName}.enabled: ${boolValue}`);
      return { oldValue: !boolValue, newValue: boolValue };
    }

    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      throw new Error(`Invalid value: ${value} (must be a number)`);
    }

    const oldValue = this.advancedFilters[filterName][param];
    this.advancedFilters[filterName][param] = numValue;
    console.log(`[FILTER] ${filterName}.${param}: ${oldValue} → ${numValue}`);
    return { oldValue, newValue: numValue };
  }

  formatFilters() {
    return JSON.parse(JSON.stringify(this.advancedFilters));
  }
}

let runtimeConfig = null;

// ============================================================================
// AGGRESSION DECAY FILTER (unchanged)
// ============================================================================

class AggressionDecayFilter {
  constructor() {
    this.aggressionHistory = new Map();
  }

  recordAggression(symbol, timestamp, buyVolume, sellVolume, priceRange) {
    if (!this.aggressionHistory.has(symbol)) {
      this.aggressionHistory.set(symbol, []);
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return;

    const dominantVolume = Math.max(buyVolume, sellVolume);
    const normalizedAggression = priceRange > 0 ? dominantVolume / priceRange : dominantVolume;

    const history = this.aggressionHistory.get(symbol);
    history.push({ timestamp, normalizedAggression });

    const config = runtimeConfig.getFilter('aggressionDecay');
    const cutoff = timestamp - (config.lookbackMinutes * 60 * 1000);
    this.aggressionHistory.set(
      symbol,
      history.filter(h => h.timestamp >= cutoff)
    );
  }

  shouldAllowEntry(symbol, currentBuyVol, currentSellVol, currentPriceRange) {
    const config = runtimeConfig.getFilter('aggressionDecay');
    if (!config.enabled) return { allowed: true, reason: 'Aggression decay filter disabled' };

    const history = this.aggressionHistory.get(symbol);
    if (!history || history.length < config.minCandles) {
      return { allowed: true, reason: 'Insufficient aggression history' };
    }

    const totalVolume = currentBuyVol + currentSellVol;
    if (totalVolume === 0) return { allowed: false, reason: 'No volume' };

    const currentDominantVol = Math.max(currentBuyVol, currentSellVol);
    const currentAggression = currentPriceRange > 0 
      ? currentDominantVol / currentPriceRange 
      : currentDominantVol;

    const avgHistoricalAggression = history.reduce((sum, h) => sum + h.normalizedAggression, 0) / history.length;

    const ratio = avgHistoricalAggression > 0 ? currentAggression / avgHistoricalAggression : 1;
    const allowed = ratio < config.decayThreshold;

    const reason = allowed
      ? `Aggression decaying: ${(ratio * 100).toFixed(1)}% of avg`
      : `Aggression still high: ${(ratio * 100).toFixed(1)}% of avg (need <${(config.decayThreshold * 100).toFixed(0)}%)`;

    return { allowed, reason, ratio: ratio.toFixed(3) };
  }

  reset(symbol) {
    this.aggressionHistory.delete(symbol);
  }
}

// ============================================================================
// STOP CLUSTER PROTECTION (unchanged)
// ============================================================================

class StopClusterProtection {
  constructor() {
    this.stopLossEvents = [];
    this.pausedUntil = 0;
  }

  recordStopLoss(symbol) {
    const config = runtimeConfig.getFilter('stopCluster');
    if (!config.enabled) return;

    const now = Date.now();
    this.stopLossEvents.push({ timestamp: now, symbol });

    const cutoff = now - (config.timeWindowMinutes * 60 * 1000);
    this.stopLossEvents = this.stopLossEvents.filter(e => e.timestamp >= cutoff);

    if (this.stopLossEvents.length >= config.maxStops) {
      this.pausedUntil = now + (config.pauseMinutes * 60 * 1000);
      console.log(`[STOP-CLUSTER] 🛑 ${this.stopLossEvents.length} stop-losses detected. Pausing for ${config.pauseMinutes} minutes`);
    }
  }

  isTradingAllowed() {
    const config = runtimeConfig.getFilter('stopCluster');
    if (!config.enabled) return { allowed: true, reason: 'Stop cluster protection disabled' };

    const now = Date.now();
    if (now < this.pausedUntil) {
      const remainingMinutes = Math.ceil((this.pausedUntil - now) / 60000);
      return { 
        allowed: false, 
        reason: `Stop cluster pause active (${remainingMinutes} min remaining)`,
        stopCount: this.stopLossEvents.length
      };
    }

    return { 
      allowed: true, 
      reason: 'No stop cluster detected',
      stopCount: this.stopLossEvents.length
    };
  }

  getStatus() {
    const now = Date.now();
    const config = runtimeConfig.getFilter('stopCluster');
    const cutoff = now - (config.timeWindowMinutes * 60 * 1000);
    const recentStops = this.stopLossEvents.filter(e => e.timestamp >= cutoff).length;

    return {
      paused: now < this.pausedUntil,
      remainingMinutes: now < this.pausedUntil ? Math.ceil((this.pausedUntil - now) / 60000) : 0,
      recentStops,
      threshold: config.maxStops
    };
  }
}

// ============================================================================
// TIME-BASED FILTER (unchanged)
// ============================================================================

class TimeBasedFilter {
  constructor() {}

  isTradingAllowed() {
    const config = runtimeConfig.getFilter('timeBased');
    if (!config.enabled) return { allowed: true, reason: 'Time filter disabled' };

    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const hourUTC = now.getUTCHours();

    if (config.blockedDays && config.blockedDays.includes(dayOfWeek)) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return { 
        allowed: false, 
        reason: `Trading blocked on ${dayNames[dayOfWeek]}` 
      };
    }

    if (config.blockedHours && config.blockedHours.includes(hourUTC)) {
      return { 
        allowed: false, 
        reason: `Trading blocked at ${hourUTC}:00 UTC` 
      };
    }

    if (config.allowedHoursStart !== undefined && config.allowedHoursEnd !== undefined) {
      if (hourUTC < config.allowedHoursStart || hourUTC >= config.allowedHoursEnd) {
        return { 
          allowed: false, 
          reason: `Outside trading hours (${config.allowedHoursStart}:00-${config.allowedHoursEnd}:00 UTC)` 
        };
      }
    }

    return { 
      allowed: true, 
      reason: `Trading allowed (${hourUTC}:00 UTC)` 
    };
  }

  formatSchedule() {
    const config = runtimeConfig.getFilter('timeBased');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    let schedule = [];
    if (config.blockedDays && config.blockedDays.length > 0) {
      const blocked = config.blockedDays.map(d => dayNames[d]).join(', ');
      schedule.push(`Blocked days: ${blocked}`);
    }
    if (config.allowedHoursStart !== undefined && config.allowedHoursEnd !== undefined) {
      schedule.push(`Hours: ${config.allowedHoursStart}:00-${config.allowedHoursEnd}:00 UTC`);
    }
    if (config.blockedHours && config.blockedHours.length > 0) {
      schedule.push(`Blocked hours: ${config.blockedHours.join(', ')} UTC`);
    }

    return schedule.length > 0 ? schedule.join(' | ') : 'No restrictions';
  }
}

// ============================================================================
// BTC VOLATILITY KILL-SWITCH (Simplified - Alert-Based)
// Перевіряє BTC раз на хвилину через REST API
// Генерує BTC_ALERT і блокує altcoins на заданий час
// ============================================================================

class BTCVolatilityFilter {
  constructor(telegram) {
    this.telegram = telegram;
    this.btcPriceHistory = [];
    this.pausedUntil = 0;
    this.lastBTCPrice = null;
    this.checkInterval = null;
    this.lastAlertTime = 0;
    this.btcAlerts = [];
  }

  async start() {
    const config = runtimeConfig.getFilter('btcVolatility');
    if (!config.enabled) {
      console.log('[BTC-FILTER] Disabled, not monitoring');
      return;
    }

    console.log(`[BTC-FILTER] Starting... (check every ${config.checkIntervalMinutes} min)`);

    // Перша перевірка одразу
    await this.checkBTC();

    // Потім перевірка кожні N хвилин
    const intervalMs = config.checkIntervalMinutes * 60 * 1000;
    this.checkInterval = setInterval(() => {
      this.checkBTC();
    }, intervalMs);

    console.log('[BTC-FILTER] ✅ Monitoring started');
  }

  async checkBTC() {
    try {
      const config = runtimeConfig.getFilter('btcVolatility');
      if (!config.enabled) return;

      // Отримуємо поточну ціну BTC через REST API
      const response = await axios.get(`${CONFIG.BINANCE_API}/fapi/v1/ticker/price?symbol=BTCUSDT`, {
        timeout: 5000
      });

      const currentPrice = parseFloat(response.data.price);
      const timestamp = Date.now();

      this.lastBTCPrice = currentPrice;
      this.btcPriceHistory.push({ timestamp, price: currentPrice });

      // Очищуємо стару історію
      const cutoff = timestamp - (config.timeframeMinutes * 60 * 1000);
      this.btcPriceHistory = this.btcPriceHistory.filter(h => h.timestamp >= cutoff);

      // Перевіряємо волатильність
      if (this.btcPriceHistory.length >= 2) {
        const oldestPrice = this.btcPriceHistory[0].price;
        const priceChange = ((currentPrice - oldestPrice) / oldestPrice) * 100;
        const absChange = Math.abs(priceChange);

        // Якщо перевищено threshold → генеруємо BTC_ALERT
        if (absChange >= config.thresholdPercent) {
          const now = Date.now();
          
          // Уникаємо дублювання алертів (тільки якщо не в паузі)
          if (now >= this.pausedUntil) {
            await this.generateBTCAlert(currentPrice, priceChange, absChange, config);
          }
        }
      }

    } catch (error) {
      console.error('[BTC-FILTER] Check error:', error.message);
    }
  }

  async generateBTCAlert(currentPrice, priceChange, absChange, config) {
    const timestamp = Date.now();
    const direction = priceChange > 0 ? 'UP ⬆️' : 'DOWN ⬇️';
    
    // Встановлюємо паузу
    this.pausedUntil = timestamp + (config.pauseMinutes * 60 * 1000);

    // Зберігаємо BTC_ALERT
    const btcAlert = {
      timestamp,
      price: currentPrice,
      changePercent: priceChange,
      absChangePercent: absChange,
      direction: priceChange > 0 ? 'UP' : 'DOWN',
      timeframeMinutes: config.timeframeMinutes,
      pauseMinutes: config.pauseMinutes
    };
    
    this.btcAlerts.push(btcAlert);
    this.lastAlertTime = timestamp;

    // Логування
    console.log(`[BTC_ALERT] 🔥 Bitcoin moved ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}% in ${config.timeframeMinutes}m`);
    console.log(`[BTC_ALERT] Direction: ${direction} | Price: $${currentPrice.toFixed(2)}`);
    console.log(`[BTC_ALERT] 🛑 Pausing all altcoin signals for ${config.pauseMinutes} minutes`);

    // Відправляємо Telegram alert
    const message = this.formatBTCAlert(btcAlert);
    try {
      await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[BTC_ALERT] Telegram error:', error.message);
    }
  }

  formatBTCAlert(alert) {
    const emoji = alert.direction === 'UP' ? '⬆️🔥' : '⬇️❄️';
    const sign = alert.changePercent >= 0 ? '+' : '';
    
    return (
      `${emoji} <b>BTC VOLATILITY ALERT</b>\n\n` +
      `⚠️ <b>Bitcoin ${alert.direction === 'UP' ? 'Pump' : 'Dump'} Detected</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `💰 BTC Price: $${alert.price.toFixed(2)}\n` +
      `📊 Change: ${sign}${alert.changePercent.toFixed(2)}% in ${alert.timeframeMinutes}m\n` +
      `📈 Magnitude: ${alert.absChangePercent.toFixed(2)}%\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🛑 <b>All altcoin signals PAUSED for ${alert.pauseMinutes} minutes</b>\n` +
      `⏰ Resume at: ${new Date(alert.timestamp + alert.pauseMinutes * 60000).toUTCString()}\n\n` +
      `<i>This is a market regime filter - no trading actions taken</i>`
    );
  }

  isTradingAllowed() {
    const config = runtimeConfig.getFilter('btcVolatility');
    if (!config.enabled) return { allowed: true, reason: 'BTC filter disabled' };

    const now = Date.now();
    if (now < this.pausedUntil) {
      const remainingMinutes = Math.ceil((this.pausedUntil - now) / 60000);
      return { 
        allowed: false, 
        reason: `BTC volatility pause (${remainingMinutes} min remaining)`,
        lastAlert: this.lastAlertTime
      };
    }

    return { 
      allowed: true, 
      reason: 'BTC volatility normal',
      btcPrice: this.lastBTCPrice
    };
  }

  getStatus() {
    const now = Date.now();
    const config = runtimeConfig.getFilter('btcVolatility');
    
    let volatility = 0;
    if (this.btcPriceHistory.length >= 2) {
      const oldestPrice = this.btcPriceHistory[0].price;
      const currentPrice = this.btcPriceHistory[this.btcPriceHistory.length - 1].price;
      volatility = Math.abs((currentPrice - oldestPrice) / oldestPrice) * 100;
    }

    return {
      paused: now < this.pausedUntil,
      remainingMinutes: now < this.pausedUntil ? Math.ceil((this.pausedUntil - now) / 60000) : 0,
      currentVolatility: volatility.toFixed(2),
      threshold: config.thresholdPercent,
      btcPrice: this.lastBTCPrice,
      alertCount: this.btcAlerts.length,
      lastAlertTime: this.lastAlertTime > 0 ? new Date(this.lastAlertTime).toISOString() : 'Never'
    };
  }

  getRecentAlerts(count = 5) {
    return this.btcAlerts.slice(-count).reverse();
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[BTC-FILTER] Stopped');
    }
  }
}

// ============================================================================
// TELEGRAM COMMAND HANDLER (Extended)
// ============================================================================

class TelegramCommandHandler {
  constructor(telegram, chatId, runtimeConfig, btcFilter) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.runtimeConfig = runtimeConfig;
    this.btcFilter = btcFilter;
  }

  async start() {
    this.telegram.onText(/\/config(\s+\w+)?/, (msg, match) => this.handleConfig(msg, match));
    this.telegram.onText(/\/set\s+(\w+)\s+(\w+)\s+(.+)/, (msg, match) => this.handleSet(msg, match));
    this.telegram.onText(/\/enable\s+(\w+)/, (msg, match) => this.handleEnable(msg, match));
    this.telegram.onText(/\/disable\s+(\w+)/, (msg, match) => this.handleDisable(msg, match));
    
    this.telegram.onText(/\/filters?/, (msg) => this.handleFilters(msg));
    this.telegram.onText(/\/filter\s+(\w+)\s+(\w+)\s+(.+)/, (msg, match) => this.handleFilterSet(msg, match));
    this.telegram.onText(/\/status/, (msg) => this.handleStatus(msg));
    this.telegram.onText(/\/btc/, (msg) => this.handleBTCStatus(msg));
    
    this.telegram.onText(/\/help/, (msg) => this.handleHelp(msg));

    console.log('[TELEGRAM] Command handler started');
  }

  async handleConfig(msg, match) {
    try {
      const symbol = match[1] ? match[1].trim().toUpperCase() : null;

      if (symbol) {
        const config = this.runtimeConfig.format(symbol);
        if (!config) {
          await this.sendMessage(`❌ Symbol ${symbol} not found`);
          return;
        }

        const status = config.enabled ? '🟢 ENABLED' : '🔴 DISABLED';
        const message = 
          `⚙️ <b>${symbol} Configuration</b>\n\n` +
          `Status: ${status}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `💰 Min Volume: $${this.formatVolume(config.minVolumeUSD)}\n` +
          `📊 Min Dominance: ${config.minDominance}%\n` +
          `📈 Min Price Change: ${config.minPriceChange}%\n` +
          `⏱ Cooldown: ${config.cooldownMinutes} min\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `Use /set ${symbol} <param> <value> to change`;

        await this.sendMessage(message);
      } else {
        const symbols = this.runtimeConfig.getAllSymbols();
        const lines = ['⚙️ <b>All Symbol Configurations</b>\n'];
        
        symbols.forEach(sym => {
          const config = this.runtimeConfig.format(sym);
          const status = config.enabled ? '🟢' : '🔴';
          lines.push(
            `${status} <b>${sym}</b>: ` +
            `$${this.formatVolume(config.minVolumeUSD)} | ` +
            `${config.minDominance}% | ` +
            `${config.minPriceChange}%`
          );
        });

        lines.push('\nUse /config SYMBOL for details');
        await this.sendMessage(lines.join('\n'));
      }
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleSet(msg, match) {
    try {
      const symbol = match[1].toUpperCase();
      const param = match[2];
      const value = match[3];

      const result = this.runtimeConfig.set(symbol, param, value);
      
      const message = 
        `✅ <b>Configuration Updated</b>\n\n` +
        `Symbol: ${symbol}\n` +
        `Parameter: ${param}\n` +
        `Old Value: ${result.oldValue}\n` +
        `New Value: ${result.newValue}\n\n` +
        `⚡ Applied immediately`;

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleEnable(msg, match) {
    try {
      const symbol = match[1].toUpperCase();
      this.runtimeConfig.enable(symbol);
      await this.sendMessage(`✅ ${symbol} monitoring <b>ENABLED</b>`);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleDisable(msg, match) {
    try {
      const symbol = match[1].toUpperCase();
      this.runtimeConfig.disable(symbol);
      await this.sendMessage(`⛔ ${symbol} monitoring <b>DISABLED</b>`);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleFilters(msg) {
    try {
      const filters = this.runtimeConfig.formatFilters();
      
      const lines = ['🎯 <b>Advanced Filters Status</b>\n'];
      
      const ad = filters.aggressionDecay;
      lines.push(`1️⃣ <b>Aggression Decay</b>: ${ad.enabled ? '🟢 ON' : '🔴 OFF'}`);
      lines.push(`   Lookback: ${ad.lookbackMinutes} min`);
      lines.push(`   Threshold: ${(ad.decayThreshold * 100).toFixed(0)}%`);
      lines.push('');
      
      const sc = filters.stopCluster;
      lines.push(`2️⃣ <b>Stop Cluster Protection</b>: ${sc.enabled ? '🟢 ON' : '🔴 OFF'}`);
      lines.push(`   Max stops: ${sc.maxStops} in ${sc.timeWindowMinutes} min`);
      lines.push(`   Pause: ${sc.pauseMinutes} min`);
      lines.push('');
      
      const tb = filters.timeBased;
      lines.push(`3️⃣ <b>Time-Based Filter</b>: ${tb.enabled ? '🟢 ON' : '🔴 OFF'}`);
      lines.push(`   Hours: ${tb.allowedHoursStart}:00-${tb.allowedHoursEnd}:00 UTC`);
      lines.push('');
      
      const btc = filters.btcVolatility;
      lines.push(`4️⃣ <b>BTC Volatility</b>: ${btc.enabled ? '🟢 ON' : '🔴 OFF'}`);
      lines.push(`   Check: every ${btc.checkIntervalMinutes} min`);
      lines.push(`   Threshold: ${btc.thresholdPercent}% in ${btc.timeframeMinutes} min`);
      lines.push(`   Pause: ${btc.pauseMinutes} min`);
      lines.push('');
      
      lines.push('━━━━━━━━━━━━━━━━━');
      lines.push('Use /filter <name> <param> <value>');
      lines.push('Use /btc for BTC alerts history');

      await this.sendMessage(lines.join('\n'));
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleFilterSet(msg, match) {
    try {
      const filterName = match[1];
      const param = match[2];
      const value = match[3];

      const result = this.runtimeConfig.setFilterParam(filterName, param, value);
      
      const message = 
        `✅ <b>Filter Updated</b>\n\n` +
        `Filter: ${filterName}\n` +
        `Parameter: ${param}\n` +
        `Old Value: ${result.oldValue}\n` +
        `New Value: ${result.newValue}\n\n` +
        `⚡ Applied immediately`;

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleStatus(msg) {
    try {
      // This will be implemented in main bot class
      await this.sendMessage('📊 Use /status in main bot');
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleBTCStatus(msg) {
    try {
      const status = this.btcFilter.getStatus();
      const recentAlerts = this.btcFilter.getRecentAlerts(3);

      const lines = ['₿ <b>BTC Volatility Filter Status</b>\n'];
      
      lines.push(`Status: ${status.paused ? '⏸ PAUSED' : '✅ ACTIVE'}`);
      if (status.paused) {
        lines.push(`Remaining: ${status.remainingMinutes} min`);
      }
      lines.push(`Current volatility: ${status.currentVolatility}%`);
      lines.push(`Threshold: ${status.threshold}%`);
      if (status.btcPrice) {
        lines.push(`BTC Price: $${status.btcPrice.toFixed(2)}`);
      }
      lines.push(`Total alerts: ${status.alertCount}`);
      lines.push(`Last alert: ${status.lastAlertTime}`);
      
      if (recentAlerts.length > 0) {
        lines.push('\n━━━━━━━━━━━━━━━━━');
        lines.push('<b>Recent BTC Alerts:</b>');
        recentAlerts.forEach((alert, i) => {
          const time = new Date(alert.timestamp).toLocaleTimeString('uk-UA', { timeZone: 'UTC' });
          const sign = alert.changePercent >= 0 ? '+' : '';
          lines.push(
            `${i + 1}. ${time} UTC: ${sign}${alert.changePercent.toFixed(2)}% ${alert.direction === 'UP' ? '⬆️' : '⬇️'}`
          );
        });
      }

      await this.sendMessage(lines.join('\n'));
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleHelp(msg) {
    const message = 
      `🤖 <b>Available Commands</b>\n\n` +
      `<b>📊 Symbol Configuration:</b>\n` +
      `/config - Show all symbols\n` +
      `/config SYMBOL - Show specific symbol\n` +
      `/set SYMBOL param value - Change setting\n` +
      `/enable SYMBOL - Enable monitoring\n` +
      `/disable SYMBOL - Disable monitoring\n\n` +
      `<b>🎯 Advanced Filters:</b>\n` +
      `/filters - Show all filter settings\n` +
      `/filter <name> <param> <value> - Change filter\n` +
      `/status - Show live filter status\n` +
      `/btc - Show BTC alerts history\n\n` +
      `<b>Filter Names:</b>\n` +
      `• aggressionDecay - Entry timing\n` +
      `• stopCluster - Stop protection\n` +
      `• timeBased - Time restrictions\n` +
      `• btcVolatility - BTC market regime\n\n` +
      `<b>Examples:</b>\n` +
      `/set ADAUSDT minVolumeUSD 700000\n` +
      `/filter aggressionDecay lookbackMinutes 5\n` +
      `/filter btcVolatility thresholdPercent 2.5\n` +
      `/filter btcVolatility pauseMinutes 20\n\n` +
      `⚡ All changes apply instantly!`;

    await this.sendMessage(message);
  }

  formatVolume(num) {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
    return num.toFixed(0);
  }

  async sendMessage(text) {
    try {
      await this.telegram.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[TELEGRAM] Send error:', error.message);
    }
  }
}

// ============================================================================
// SYMBOL STATE (unchanged)
// ============================================================================

class SymbolState {
  constructor(symbol, windowSeconds) {
    this.symbol = symbol;
    this.windowMs = windowSeconds * 1000;
    this.trades = [];
    this.firstPrice = null;
    this.lastPrice = null;
    this.highPrice = null;
    this.lowPrice = null;
  }

  addTrade(timestamp, price, quantity, isBuyerMaker) {
    const volume = price * quantity;
    
    const trade = {
      timestamp,
      price,
      buyVol: isBuyerMaker ? 0 : volume,
      sellVol: isBuyerMaker ? volume : 0
    };

    this.trades.push(trade);
    this.lastPrice = price;
    
    if (this.firstPrice === null) {
      this.firstPrice = price;
      this.highPrice = price;
      this.lowPrice = price;
    } else {
      this.highPrice = Math.max(this.highPrice, price);
      this.lowPrice = Math.min(this.lowPrice, price);
    }

    this.cleanup(timestamp);
  }

  cleanup(currentTime) {
    const cutoff = currentTime - this.windowMs;
    this.trades = this.trades.filter(t => t.timestamp >= cutoff);

    if (this.trades.length > 0) {
      this.firstPrice = this.trades[0].price;
      this.highPrice = Math.max(...this.trades.map(t => t.price));
      this.lowPrice = Math.min(...this.trades.map(t => t.price));
    } else {
      this.firstPrice = null;
      this.highPrice = null;
      this.lowPrice = null;
    }
  }

  getStats() {
    if (this.trades.length === 0) return null;

    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of this.trades) {
      buyVolume += trade.buyVol;
      sellVolume += trade.sellVol;
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return null;

    const buyDominance = (buyVolume / totalVolume) * 100;
    const sellDominance = (sellVolume / totalVolume) * 100;
    
    const dominantSide = buyVolume > sellVolume ? 'buy' : 'sell';
    const dominance = Math.max(buyDominance, sellDominance);

    const priceChange = this.firstPrice 
      ? ((this.lastPrice - this.firstPrice) / this.firstPrice) * 100
      : 0;

    const priceRange = this.highPrice && this.lowPrice 
      ? this.highPrice - this.lowPrice 
      : 0;

    const duration = (this.trades[this.trades.length - 1].timestamp - this.trades[0].timestamp) / 1000;

    return {
      buyVolume,
      sellVolume,
      totalVolume,
      dominantSide,
      dominance,
      priceChange,
      priceRange,
      duration,
      tradeCount: this.trades.length,
      lastPrice: this.lastPrice,
      highPrice: this.highPrice,
      lowPrice: this.lowPrice
    };
  }

  reset() {
    this.trades = [];
    this.firstPrice = null;
    this.lastPrice = null;
    this.highPrice = null;
    this.lowPrice = null;
  }
}

// ============================================================================
// TRADE AGGREGATOR (unchanged)
// ============================================================================

class TradeAggregator {
  constructor(windowSeconds) {
    this.windowSeconds = windowSeconds;
    this.states = new Map();
  }

  addTrade(symbol, timestamp, price, quantity, isBuyerMaker) {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, new SymbolState(symbol, this.windowSeconds));
    }
    this.states.get(symbol).addTrade(timestamp, price, quantity, isBuyerMaker);
  }

  getStats(symbol) {
    const state = this.states.get(symbol);
    return state ? state.getStats() : null;
  }

  resetSymbol(symbol) {
    const state = this.states.get(symbol);
    if (state) state.reset();
  }

  getActiveCount() {
    return this.states.size;
  }

  getTotalTrades() {
    let total = 0;
    for (const state of this.states.values()) {
      total += state.trades.length;
    }
    return total;
  }
}

// ============================================================================
// SIGNAL ENGINE (integrates filters)
// ============================================================================

class SignalEngine {
  constructor(aggressionFilter, stopClusterFilter, timeFilter, btcFilter) {
    this.aggressionFilter = aggressionFilter;
    this.stopClusterFilter = stopClusterFilter;
    this.timeFilter = timeFilter;
    this.btcFilter = btcFilter;
  }

  shouldAlert(symbol, stats) {
    if (!stats) return { allow: false, reason: 'No stats' };
    
    const config = runtimeConfig.get(symbol);
    if (!config || !config.enabled) {
      return { allow: false, reason: 'Symbol disabled' };
    }
    
    // Core filters (unchanged)
    if (stats.totalVolume < config.minVolumeUSD) {
      return { allow: false, reason: `Volume too low: $${(stats.totalVolume / 1e6).toFixed(2)}M < $${(config.minVolumeUSD / 1e6).toFixed(2)}M` };
    }
    
    if (stats.dominance < config.minDominance) {
      return { allow: false, reason: `Dominance too low: ${stats.dominance.toFixed(1)}% < ${config.minDominance}%` };
    }
    
    if (Math.abs(stats.priceChange) < config.minPriceChange) {
      return { allow: false, reason: `Price change too small: ${Math.abs(stats.priceChange).toFixed(2)}% < ${config.minPriceChange}%` };
    }
    
    if (stats.dominantSide === 'buy' && stats.priceChange < 0) {
      return { allow: false, reason: 'Buy dominance but price down' };
    }
    if (stats.dominantSide === 'sell' && stats.priceChange > 0) {
      return { allow: false, reason: 'Sell dominance but price up' };
    }

    // Aggression Decay
    const aggressionCheck = this.aggressionFilter.shouldAllowEntry(
      symbol,
      stats.buyVolume,
      stats.sellVolume,
      stats.priceRange
    );
    if (!aggressionCheck.allowed) {
      return { allow: false, reason: `Aggression: ${aggressionCheck.reason}`, details: aggressionCheck };
    }

    // Stop Cluster
    const stopCheck = this.stopClusterFilter.isTradingAllowed();
    if (!stopCheck.allowed) {
      return { allow: false, reason: stopCheck.reason };
    }

    // Time-Based
    const timeCheck = this.timeFilter.isTradingAllowed();
    if (!timeCheck.allowed) {
      return { allow: false, reason: timeCheck.reason };
    }

    // BTC Volatility (Kill-Switch)
    const btcCheck = this.btcFilter.isTradingAllowed();
    if (!btcCheck.allowed) {
      return { allow: false, reason: btcCheck.reason };
    }

    return { 
      allow: true, 
      reason: 'All filters passed',
      details: {
        aggression: aggressionCheck,
        stopCluster: stopCheck,
        time: timeCheck,
        btc: btcCheck
      }
    };
  }

  interpretSignal(stats) {
    if (stats.dominantSide === 'buy') {
      return {
        type: 'SHORT_SQUEEZE',
        label: 'SHORT SQUEEZE',
        emoji: '🟢',
        direction: 'BUY',
        description: 'Aggressive buying pressure pushing shorts out'
      };
    } else {
      return {
        type: 'LONG_LIQUIDATION',
        label: 'LONG LIQUIDATION',
        emoji: '🔴',
        direction: 'SELL',
        description: 'Aggressive selling pressure liquidating longs'
      };
    }
  }
}

// ============================================================================
// COOLDOWN MANAGER (unchanged)
// ============================================================================

class CooldownManager {
  constructor() {
    this.lastAlerts = new Map();
  }

  canAlert(symbol, stats) {
    const config = runtimeConfig.get(symbol);
    if (!config) return false;

    const key = `${symbol}_${stats.dominantSide}`;
    const lastAlert = this.lastAlerts.get(key);
    
    if (!lastAlert) return true;
    
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastAlert;
    
    return elapsed >= cooldownMs;
  }

  recordAlert(symbol, stats) {
    const key = `${symbol}_${stats.dominantSide}`;
    this.lastAlerts.set(key, Date.now());
  }

  getRemainingCooldown(symbol, side) {
    const config = runtimeConfig.get(symbol);
    if (!config) return 0;

    const key = `${symbol}_${side}`;
    const lastAlert = this.lastAlerts.get(key);
    
    if (!lastAlert) return 0;
    
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastAlert;
    const remaining = Math.max(0, cooldownMs - elapsed);
    
    return Math.ceil(remaining / 1000);
  }
}

// ============================================================================
// ALERT MANAGER (unchanged - wait logic preserved)
// ============================================================================

class AlertManager {
  constructor(telegram, aggressionFilter) {
    this.telegram = telegram;
    this.aggressionFilter = aggressionFilter;
    this.alertCount = 0;
    this.pendingAlerts = new Map();
  }

  async sendAlert(symbol, stats, interpretation, filterDetails) {
    const key = `${symbol}_${stats.dominantSide}`;
    if (this.pendingAlerts.has(key)) {
      return;
    }

    this.aggressionFilter.recordAggression(
      symbol,
      Date.now(),
      stats.buyVolume,
      stats.sellVolume,
      stats.priceRange
    );

    // Wait until next minute (CRITICAL - unchanged)
    const now = Date.now();
    const nextMinute = Math.ceil(now / 60000) * 60000;
    const delay = nextMinute - now;

    console.log(`[ALERT] ${symbol} ${interpretation.label} - waiting ${(delay/1000).toFixed(1)}s until next minute`);
    
    if (filterDetails) {
      console.log(`[ALERT] Filter details:`, JSON.stringify(filterDetails, null, 2));
    }
    
    this.pendingAlerts.set(key, true);

    setTimeout(async () => {
      try {
        const message = CONFIG.ALERT_FORMAT === 'structured'
          ? this.formatStructuredMessage(symbol, stats, interpretation)
          : this.formatHumanMessage(symbol, stats, interpretation);

        await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
        
        this.alertCount++;
        console.log(`[ALERT] ${symbol} sent (${this.alertCount} total)`);
      } catch (error) {
        console.error(`[ALERT] Error:`, error.message);
      } finally {
        this.pendingAlerts.delete(key);
      }
    }, delay);
  }

  formatStructuredMessage(symbol, stats, interpretation) {
    const data = {
      timestamp: Date.now(),
      symbol: symbol,
      signal: interpretation.type,
      direction: interpretation.direction,
      volume: stats.totalVolume,
      dominance: stats.dominance,
      priceChange: stats.priceChange,
      lastPrice: stats.lastPrice,
      duration: stats.duration
    };

    const lines = [];
    lines.push(`${interpretation.emoji} <b>${interpretation.label}</b>`);
    lines.push(`<code>───────────────────</code>`);
    lines.push(`<b>Symbol:</b> <code>${symbol}</code>`);
    lines.push(`<b>Direction:</b> <code>${interpretation.direction}</code>`);
    lines.push(`<b>Volume:</b> $${this.fmt(stats.totalVolume)} in ${stats.duration.toFixed(0)}s`);
    lines.push(`<b>Dominance:</b> ${stats.dominance.toFixed(1)}%`);
    lines.push(`<b>Price Δ:</b> ${stats.priceChange >= 0 ? '+' : ''}${stats.priceChange.toFixed(2)}%`);
    lines.push(`<b>Last Price:</b> $${stats.lastPrice.toFixed(4)}`);
    lines.push(`<code>───────────────────</code>`);
    lines.push(`<code>${JSON.stringify(data)}</code>`);
    
    return lines.join('\n');
  }

  formatHumanMessage(symbol, stats, interpretation) {
    const lines = [];
    
    lines.push(`${interpretation.emoji} ${interpretation.label}`);
    lines.push(`💰 Volume: $${this.fmt(stats.totalVolume)} in ${stats.duration.toFixed(0)}s`);
    lines.push(`📊 Dominance: ${stats.dominance.toFixed(1)}% ${interpretation.direction}`);
    lines.push('━━━━━━━━━━━━━━━━━');
    
    const cleanSymbol = symbol.replace('USDT', '');
    lines.push(`🎯 ${symbol} #${cleanSymbol}`);
    
    const priceSign = stats.priceChange >= 0 ? '+' : '';
    lines.push(`📈 Price Δ: ${priceSign}${stats.priceChange.toFixed(2)}%`);
    lines.push(`💵 Last: $${stats.lastPrice.toFixed(4)}`);
    
    lines.push('━━━━━━━━━━━━━━━━━');
    lines.push(`🟢 Aggressive Buy: $${this.fmt(stats.buyVolume)}`);
    lines.push(`🔴 Aggressive Sell: $${this.fmt(stats.sellVolume)}`);
    
    return lines.join('\n');
  }

  fmt(num) {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
    return num.toFixed(0);
  }

  getCount() {
    return this.alertCount;
  }

  getPendingCount() {
    return this.pendingAlerts.size;
  }
}

// ============================================================================
// MULTI-WEBSOCKET MANAGER (unchanged)
// ============================================================================

class MultiWebSocketManager {
  constructor(symbols, tradeAggregator, signalEngine, cooldownManager, alertManager) {
    this.symbols = symbols;
    this.tradeAggregator = tradeAggregator;
    this.signalEngine = signalEngine;
    this.cooldownManager = cooldownManager;
    this.alertManager = alertManager;
    
    this.connections = new Map();
    this.tradeCount = 0;
    this.lastStatsLog = Date.now();
    this.reconnectAttempts = new Map();
  }

  connectAll() {
    console.log(`[WS] Connecting to ${this.symbols.length} symbols...`);
    
    this.symbols.forEach((symbol, i) => {
      setTimeout(() => this.connectSymbol(symbol), i * 200);
    });
  }

  connectSymbol(symbol) {
    const streamName = `${symbol.toLowerCase()}@aggTrade`;
    const url = `${CONFIG.BINANCE_WS}/${streamName}`;
    
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[WS] ${symbol} connected`);
      this.reconnectAttempts.set(symbol, 0);
    });

    ws.on('message', (data) => {
      this.handleMessage(symbol, data);
    });

    ws.on('error', (error) => {
      console.error(`[WS] ${symbol} error:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[WS] ${symbol} closed`);
      this.reconnectSymbol(symbol);
    });

    this.connections.set(symbol, ws);
  }

  handleMessage(symbol, data) {
    try {
      const trade = JSON.parse(data);
      
      const price = parseFloat(trade.p);
      const quantity = parseFloat(trade.q);
      const timestamp = trade.T;
      const isBuyerMaker = trade.m;
      
      this.tradeAggregator.addTrade(symbol, timestamp, price, quantity, isBuyerMaker);
      this.tradeCount++;
      
      const stats = this.tradeAggregator.getStats(symbol);
      const config = runtimeConfig.get(symbol);
      
      if (stats && config && stats.totalVolume >= config.minVolumeUSD * 0.5) {
        const signalCheck = this.signalEngine.shouldAlert(symbol, stats);
        
        if (signalCheck.allow) {
          if (this.cooldownManager.canAlert(symbol, stats)) {
            const interpretation = this.signalEngine.interpretSignal(stats);
            this.alertManager.sendAlert(symbol, stats, interpretation, signalCheck.details);
            this.cooldownManager.recordAlert(symbol, stats);
            this.tradeAggregator.resetSymbol(symbol);
          } else {
            const remaining = this.cooldownManager.getRemainingCooldown(symbol, stats.dominantSide);
            console.log(`[SIGNAL] ${symbol} blocked by cooldown (${remaining}s remaining)`);
          }
        } else {
          if (signalCheck.reason !== 'No stats' && signalCheck.reason !== 'Symbol disabled') {
            console.log(`[SIGNAL] ${symbol} blocked: ${signalCheck.reason}`);
          }
        }
      }
      
      this.logStats();
      
    } catch (error) {
      console.error(`[WS] ${symbol} parse error:`, error.message);
    }
  }

  logStats() {
    const now = Date.now();
    if (now - this.lastStatsLog < CONFIG.STATS_LOG_INTERVAL * 1000) {
      return;
    }

    const activeSymbols = this.tradeAggregator.getActiveCount();
    const totalTrades = this.tradeAggregator.getTotalTrades();
    const alerts = this.alertManager.getCount();
    const pendingAlerts = this.alertManager.getPendingCount();
    const connected = Array.from(this.connections.values()).filter(ws => ws.readyState === WebSocket.OPEN).length;
    
    console.log(`[STATS] Connected: ${connected}/${this.symbols.length} | Active: ${activeSymbols} | Trades: ${totalTrades} | Alerts: ${alerts} | Pending: ${pendingAlerts} | Rate: ${(this.tradeCount / CONFIG.STATS_LOG_INTERVAL).toFixed(0)}/s`);
    
    this.tradeCount = 0;
    this.lastStatsLog = now;
  }

  reconnectSymbol(symbol) {
    const attempts = this.reconnectAttempts.get(symbol) || 0;
    
    if (attempts >= CONFIG.MAX_RECONNECTS) {
      console.error(`[WS] ${symbol} max reconnects reached`);
      return;
    }

    this.reconnectAttempts.set(symbol, attempts + 1);
    
    setTimeout(() => {
      console.log(`[WS] ${symbol} reconnecting (${attempts + 1}/${CONFIG.MAX_RECONNECTS})...`);
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
    runtimeConfig = new RuntimeConfig(CONFIG.SYMBOL_CONFIGS, CONFIG.ADVANCED_FILTERS);
    
    this.aggressionFilter = new AggressionDecayFilter();
    this.stopClusterFilter = new StopClusterProtection();
    this.timeFilter = new TimeBasedFilter();
    
    this.telegram = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
    
    // BTC Filter needs telegram for alerts
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
        
        const agConfig = runtimeConfig.getFilter('aggressionDecay');
        lines.push(`⚡ <b>Aggression Decay:</b> ${agConfig.enabled ? '✅ ON' : '🔴 OFF'}`);
        
        lines.push('\n━━━━━━━━━━━━━━━━━');
        lines.push(`Alerts sent: ${this.alertManager.getCount()}`);
        lines.push(`Pending: ${this.alertManager.getPendingCount()}`);

        await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, lines.join('\n'), { parse_mode: 'HTML' });
      } catch (error) {
        console.error('[STATUS] Error:', error.message);
      }
    });
  }

  async start() {
    const symbols = runtimeConfig.getEnabledSymbols();
    
    console.log('='.repeat(70));
    console.log('BINANCE FUTURES AGGRESSIVE FLOW MONITOR (MVP Enhanced)');
    console.log('+ Entry Timing Optimization');
    console.log('+ Stop Cluster Protection');
    console.log('+ Time-Based Filters');
    console.log('+ BTC Volatility Kill-Switch (Alert-Based)');
    console.log('='.repeat(70));
    console.log(`Symbols: ${symbols.length} | Window: ${CONFIG.WINDOW_SECONDS}s`);
    console.log('Individual Symbol Settings:');
    
    symbols.forEach(symbol => {
      const config = runtimeConfig.get(symbol);
      console.log(`  ${symbol}: Vol=$${(config.minVolumeUSD / 1e6).toFixed(1)}M | Dom=${config.minDominance}% | Δ=${config.minPriceChange}%`);
    });
    
    console.log('='.repeat(70));
    console.log('Advanced Filters:');
    const filters = runtimeConfig.formatFilters();
    console.log(`  Aggression Decay: ${filters.aggressionDecay.enabled ? 'ON' : 'OFF'}`);
    console.log(`  Stop Cluster: ${filters.stopCluster.enabled ? 'ON' : 'OFF'}`);
    console.log(`  Time-Based: ${filters.timeBased.enabled ? 'ON' : 'OFF'}`);
    console.log(`  BTC Volatility: ${filters.btcVolatility.enabled ? 'ON' : 'OFF'} (Check: ${filters.btcVolatility.checkIntervalMinutes}min)`);
    console.log('='.repeat(70));

    // Start BTC monitoring (simplified - REST API based)
    await this.btcFilter.start();

    this.commandHandler = new TelegramCommandHandler(
      this.telegram,
      CONFIG.TELEGRAM_CHAT_ID,
      runtimeConfig,
      this.btcFilter
    );
    await this.commandHandler.start();

    try {
      const startMessage = symbols.map(s => {
        const c = runtimeConfig.get(s);
        return `• ${s}: $${(c.minVolumeUSD / 1e6).toFixed(1)}M | ${c.minDominance}% | ${c.minPriceChange}%`;
      }).join('\n');
      
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        `🚀 <b>Binance Futures Monitor Started (MVP Enhanced)</b>\n\n` +
        `<b>📊 Monitoring ${symbols.length} symbols:</b>\n${startMessage}\n\n` +
        `<b>🎯 Advanced Filters:</b>\n` +
        `• Aggression Decay: ${filters.aggressionDecay.enabled ? '✅' : '❌'}\n` +
        `• Stop Cluster Protection: ${filters.stopCluster.enabled ? '✅' : '❌'}\n` +
        `• Time-Based Filter: ${filters.timeBased.enabled ? '✅' : '❌'}\n` +
        `• BTC Volatility (Alert-Based): ${filters.btcVolatility.enabled ? '✅' : '❌'}\n\n` +
        `📱 Commands: /help | /status | /btc | /filters`,
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
