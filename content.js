// content.js
// Price Overlay Simulator - Full content script with settings, persistence,
// mutation-observer price sync, element selector, fake trading simulator,
// analytics charts, and per-token storage.
//
// Notes:
// - Stores per-token data under chrome.storage.local with key `pos::<host>::<tokenId>`
// - TokenId is derived from detected token name or pathname fallback.
// - Does NOT perform any network trades; simulation only.

(() => {
  if (window.__pos_overlay_active) return;
  window.__pos_overlay_active = true;

  // ---------- Config / Defaults ----------
  const DEFAULTS = {
    emaShort: 12,
    emaLong: 26,
    rsiPeriod: 14,
    pollIntervalMs: 2000,
    maxHistory: 1200, // keep up to ~1200 points
    simStartBalance: 10000,
    simulateTrading: false,
    showAnalytics: false,
    theme: "dark"
  };

  // Helper: unique token key (host + token identifier)
  function getTokenKey() {
    const host = location.host;
    const tokenIdent = detectTokenName() || location.pathname || "unknown";
    // normalize
    const safe = tokenIdent.replace(/[^\w\-]/g, "_").slice(0, 64);
    return `pos::${host}::${safe}`;
  }

  // ---------- Storage helpers ----------
  function saveState(key, state) {
    const o = {};
    o[key] = state;
    try {
      chrome.storage.local.set(o, () => {});
    } catch (e) {
      console.warn("storage.set failed", e);
    }
  }
  function loadState(key) {
    return new Promise((res) => {
      try {
        chrome.storage.local.get([key], (items) => {
          res(items[key]);
        });
      } catch (e) {
        console.warn("storage.get failed", e);
        res(undefined);
      }
    });
  }

  // ---------- Utility ----------
  function parsePriceText(text) {
    if (!text || typeof text !== "string") return NaN;
    // common patterns: $1,234.56 or 0.0001234
    const cleaned = text.replace(/,/g, "").match(/-?\d+(\.\d+)?(e-?\d+)?/i);
    if (!cleaned) return NaN;
    const n = parseFloat(cleaned[0]);
    return Number.isFinite(n) ? n : NaN;
  }
  function nowTs() { return Date.now(); }

  // ---------- Token / Coin detection ----------
  function detectTokenName() {
    // Try a few heuristics: meta tags, data-testid selectors, h1, url slug
    let el = document.querySelector('[data-testid="token-name"], [data-testid="name"], .token-name, .pair-name, .symbol, .tokenSymbol, .tokenTitle, h1');
    if (el && el.textContent && el.textContent.trim().length > 0) {
      return el.textContent.trim().replace(/\s+/g, " ");
    }
    // meta title
    const mt = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
    if (mt && mt.content) return mt.content;
    // document title (may contain "BTC/USDT - Dexscreener" etc)
    if (document.title) {
      // try to extract coin symbol at start "BTC / USDT" or "Token - site"
      const m = document.title.split(" - ")[0].trim();
      if (m) return m;
    }
    // fallback to last path segment
    const path = location.pathname.split("/").filter(Boolean);
    return path.length ? path[path.length - 1] : null;
  }

  // ---------- DOM: overlay UI creation ----------
  const overlay = document.createElement("div");
  overlay.id = "pos-overlay";
  overlay.style.cssText = `
    position: fixed; right: 12px; top: 12px; width: 320px;
    z-index: 2147483647; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial;
  `;
  overlay.innerHTML = `
    <div id="pos-card" style="background: rgba(12,12,16,0.95); color:#eee; border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,0.6); overflow:hidden; border:1px solid rgba(255,255,255,0.04)">
      <div id="pos-header" style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; cursor:move;">
        <div style="font-weight:700; font-size:13px">Signal Overlay <span id="pos-token" style="font-weight:600; opacity:0.9; font-size:12px">(loading)</span></div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button id="pos-settings-btn" title="Settings" style="background:transparent; border:none; color:inherit; cursor:pointer; font-size:14px">⚙️</button>
          <button id="pos-min-btn" title="Minimize" style="background:transparent; border:none; color:inherit; cursor:pointer">—</button>
        </div>
      </div>
      <div id="pos-body" style="padding:10px; font-size:13px; line-height:1.2;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <div>
            <div style="font-size:12px; color:#bbb">Price</div>
            <div style="font-weight:700; font-size:16px"><span id="pos-price">—</span></div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:12px; color:#bbb">Signal</div>
            <div id="pos-signal" style="font-weight:800; font-size:16px; color:#ccc">HOLD</div>
          </div>
        </div>

        <div id="pos-meta" style="margin-top:8px; display:flex; gap:8px; align-items:center; justify-content:space-between;">
          <div style="font-size:12px; color:#9aa">EMA <span id="pos-ema-short">—</span>/<span id="pos-ema-long">—</span></div>
          <div style="font-size:12px; color:#9aa">RSI <span id="pos-rsi">—</span></div>
        </div>

        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
          <button id="pos-select-btn" style="flex:1; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit; cursor:pointer">Select Price Element</button>
          <button id="pos-reset-btn" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit; cursor:pointer">Reset</button>
        </div>

        <div id="pos-small" style="margin-top:8px; font-size:12px; color:#aab;">
          <div>Selector: <span id="pos-selector">auto</span></div>
          <div style="margin-top:6px">History: <span id="pos-history-size">0</span> pts</div>
        </div>

        <div id="pos-analytics" style="display:none; margin-top:10px;">
          <canvas id="pos-price-chart" width="300" height="90" style="background:transparent; display:block; border-radius:6px;"></canvas>
          <canvas id="pos-portfolio-chart" width="300" height="60" style="margin-top:6px; display:block; border-radius:6px;"></canvas>
          <div id="pos-sim-stats" style="margin-top:8px; display:flex; gap:8px; font-size:12px;">
            <div>Balance: <b id="pos-balance">—</b></div>
            <div>Holdings: <b id="pos-holdings">—</b></div>
            <div>Value: <b id="pos-value">—</b></div>
          </div>
          <div id="pos-trades" style="margin-top:8px; max-height:110px; overflow:auto; font-size:12px; color:#ddd; border-top:1px dashed rgba(255,255,255,0.03); padding-top:6px"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // drag handling for overlay
  (function makeDraggable() {
    const header = document.getElementById("pos-header");
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      overlay.style.transition = "none";
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      overlay.style.left = (startLeft + dx) + "px";
      overlay.style.top = (startTop + dy) + "px";
    });
    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        overlay.style.transition = "";
        document.body.style.userSelect = "";
      }
    });
  })();

  // Shortcut: minimize
  document.getElementById("pos-min-btn").addEventListener("click", () => {
    const body = document.getElementById("pos-body");
    if (body.style.display === "none") {
      body.style.display = "";
      document.getElementById("pos-min-btn").textContent = "—";
    } else {
      body.style.display = "none";
      document.getElementById("pos-min-btn").textContent = "+";
    }
  });

  // ---------- State ----------
  const tokenKey = getTokenKey();
  let settings = { ...DEFAULTS };
  let selector = null; // user-chosen selector string
  let priceHistory = []; // {ts, price}
  let priceOnlyHistory = []; // numeric
  let emaShort = null, emaLong = null;
  let lastSignal = "HOLD";
  let observer = null;
  let selectionMode = false;
  let selectionHighlighter = null;

  // Simulation state
  let sim = {
    balance: DEFAULTS.simStartBalance,
    holdings: 0,
    trades: [], // {type:'BUY'|'SELL', price, ts}
    portfolioHistory: [] // {ts, value}
  };

  // ---------- Load persisted per-token state ----------
  (async () => {
    const saved = await loadState(tokenKey);
    if (saved && typeof saved === "object") {
      // restore settings if present
      if (saved.settings) settings = { ...settings, ...saved.settings };
      if (saved.selector) selector = saved.selector;
      if (saved.sim) sim = saved.sim;
      if (Array.isArray(saved.priceHistory)) {
        priceHistory = saved.priceHistory.slice(-settings.maxHistory);
        priceOnlyHistory = priceHistory.map(p => p.price);
        if (priceOnlyHistory.length) {
          emaShort = priceOnlyHistory.slice(-settings.emaShort).reduce((a,b)=>a+b,0) / Math.max(1, Math.min(settings.emaShort, priceOnlyHistory.length));
          emaLong = priceOnlyHistory.slice(-settings.emaLong).reduce((a,b)=>a+b,0) / Math.max(1, Math.min(settings.emaLong, priceOnlyHistory.length));
        }
      }
    } else {
      // initialize sim balance if not present
      sim.balance = settings.simStartBalance;
    }

    // Apply UI initial state
    document.getElementById("pos-selector").textContent = selector ? selector : "auto";
    document.getElementById("pos-history-size").textContent = priceOnlyHistory.length;
    document.getElementById("pos-token").textContent = `(${detectTokenName() || "unknown"})`;

    if (settings.showAnalytics) {
      document.getElementById("pos-analytics").style.display = "block";
    }
  })();

  // ---------- Save loop (throttle) ----------
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const toSave = {
        settings,
        selector,
        sim,
        priceHistory: priceHistory.slice(-settings.maxHistory)
      };
      saveState(tokenKey, toSave);
    }, 500);
  }

  // ---------- Price element selection tool ----------
  document.getElementById("pos-select-btn").addEventListener("click", () => {
    if (selectionMode) {
      stopSelectionMode();
      return;
    }
    startSelectionMode();
  });

  function startSelectionMode() {
    selectionMode = true;
    document.getElementById("pos-select-btn").textContent = "Click the price on page (Esc to cancel)";
    // temporarily disable pointer-events on overlay so user can click page elements
    const card = document.getElementById("pos-card");
    card.style.pointerEvents = "none";
    document.body.style.cursor = "crosshair";

    // highlight element under mouse and set selector on click
    function onMouseMove(e) {
      const target = e.target;
      if (!target || target === overlay || overlay.contains(target)) return;
      if (selectionHighlighter) selectionHighlighter.remove();
      selectionHighlighter = document.createElement("div");
      const rect = target.getBoundingClientRect();
      selectionHighlighter.style.cssText = `
        position:fixed; left:${rect.left}px; top:${rect.top}px;
        width:${rect.width}px; height:${rect.height}px;
        background: rgba(255, 204, 0, 0.12);
        outline: 2px solid rgba(255,204,0,0.9); z-index:2147483646; pointer-events:none;
      `;
      document.body.appendChild(selectionHighlighter);
    }
    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      if (!target) return;
      // compute a unique-ish selector
      const sel = buildUniqueSelector(target);
      selector = sel;
      document.getElementById("pos-selector").textContent = selector;
      // stop and bind
      stopSelectionMode();
      bindToSelector(selector, true);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        stopSelectionMode();
      }
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    // store handlers to remove later
    startSelectionMode.cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
      if (selectionHighlighter) { selectionHighlighter.remove(); selectionHighlighter = null; }
      document.body.style.cursor = "";
      const card = document.getElementById("pos-card");
      card.style.pointerEvents = "";
    };
  }

  function stopSelectionMode() {
    selectionMode = false;
    document.getElementById("pos-select-btn").textContent = "Select Price Element";
    if (startSelectionMode.cleanup) startSelectionMode.cleanup();
  }

  function buildUniqueSelector(el) {
    if (!(el instanceof Element)) return null;
    // If element has id -> use it
    if (el.id) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === "string") {
        const cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0,2).join(".");
        if (cls) part += `.${cls}`;
      }
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(part); break; }
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (siblings.length > 1) {
        const idx = Array.prototype.indexOf.call(parent.children, cur) + 1; // nth-child is 1-based
        part += `:nth-child(${idx})`;
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length > 6) break; // stop at some depth
    }
    return parts.join(" > ");
  }

  // ---------- Auto-detect price element & robust binding ----------
  function tryAutoDetectSelector() {
    // Candidate selectors (site-specific heuristics)
    const candidates = [
      '[data-testid="token-price"]',
      '[data-testid="price"]',
      '.price',
      '.token-price',
      '.pair-price',
      '.priceValue',
      '.current-price',
      '[class*="price"]',
      '.price-text',
      '.tokenPrice',
      '.ticker-price'
    ];
    for (const s of candidates) {
      const el = document.querySelector(s);
      if (el && /\d/.test(el.textContent || "")) return s;
    }
    // fallback: choose short numeric-containing text nodes near top (h1/h2)
    const txtEls = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3'));
    let best = null;
    for (const el of txtEls) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (/\$?\d{1,3}(,\d{3})*(\.\d+)?/.test(t) || /\d+\.\d{2,}/.test(t)) {
        if (!best || t.length < best.text.length) best = {el, text: t};
      }
    }
    return best ? buildUniqueSelector(best.el) : null;
  }

  function bindToSelector(sel, userTriggered=false) {
    // unobserve old
    if (observer) { observer.disconnect(); observer = null; }

    if (!sel) {
      sel = tryAutoDetectSelector();
      if (!sel) {
        console.warn("pos: auto-detect failed");
        document.getElementById("pos-selector").textContent = "none";
        return;
      }
    }
    document.getElementById("pos-selector").textContent = sel;
    selector = sel;
    scheduleSave();

    // try to find element and attach mutation observer
    const el = document.querySelector(selector);
    if (!el) {
      console.warn("pos: selector found no element", selector);
      // fallback: if userTriggered, let's keep selector but watch document changes for it
      // attempt polling for the element appearance
      let tries = 0;
      const pid = setInterval(() => {
        tries++;
        const e = document.querySelector(selector);
        if (e) {
          clearInterval(pid);
          bindToSelector(selector, false);
        } else if (tries > 60) {
          clearInterval(pid);
        }
      }, 1000);
      return;
    }

    // initial parse
    const p = parsePriceText(el.textContent || el.innerText || "");
    if (Number.isFinite(p)) {
      pushPrice(p);
      renderAll();
    }

    // Create observer
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList" || m.type === "characterData" || m.type === "subtree") {
          const txt = el.textContent || el.innerText || "";
          const val = parsePriceText(txt);
          if (Number.isFinite(val)) {
            pushPrice(val);
          }
        }
      }
    });

    try {
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    } catch (e) {
      // Some nodes can't be observed directly; fall back to polling
      console.warn("pos: observer failed, falling back to polling", e);
      const pollId = setInterval(() => {
        if (!document.body.contains(el)) { clearInterval(pollId); return; }
        const txt = el.textContent || el.innerText || "";
        const val = parsePriceText(txt);
        if (Number.isFinite(val)) pushPrice(val);
      }, settings.pollIntervalMs || 2000);
      // store pollId as observer for later cleanup
      observer = { disconnect: () => clearInterval(pollId) };
    }
  }

  // ---------- Fallback general poller (if not bound) ----------
  let generalPollerId = null;
  function startGeneralPoller() {
    if (generalPollerId) return;
    generalPollerId = setInterval(() => {
      if (selector) return; // bound mode preferred
      // try to auto-detect and bind if found
      const s = tryAutoDetectSelector();
      if (s) bindToSelector(s);
    }, settings.pollIntervalMs || 2000);
  }
  function stopGeneralPoller() { if (generalPollerId) { clearInterval(generalPollerId); generalPollerId = null; } }

  // ---------- Price history push + indicators ----------
  function pushPrice(price) {
    if (!Number.isFinite(price)) return;
    const ts = nowTs();
    priceHistory.push({ ts, price });
    priceOnlyHistory.push(price);
    if (priceHistory.length > settings.maxHistory) priceHistory.shift();
    if (priceOnlyHistory.length > settings.maxHistory) priceOnlyHistory.shift();

    // incremental EMA
    if (emaShort === null) {
      const slice = priceOnlyHistory.slice(-settings.emaShort);
      emaShort = slice.reduce((a,b)=>a+b,0) / Math.max(1, slice.length);
    } else {
      const k = 2 / (settings.emaShort + 1);
      emaShort = (price - emaShort) * k + emaShort;
    }
    if (emaLong === null) {
      const sliceL = priceOnlyHistory.slice(-settings.emaLong);
      emaLong = sliceL.reduce((a,b)=>a+b,0) / Math.max(1, sliceL.length);
    } else {
      const kL = 2 / (settings.emaLong + 1);
      emaLong = (price - emaLong) * kL + emaLong;
    }

    // compute RSI (simple)
    const rsi = computeRSI(settings.rsiPeriod);

    // decide signal
    const signal = decideSignal(emaShort, emaLong, rsi);
    lastSignal = signal;

    // if simulation enabled, run simulation step
    if (settings.simulateTrading) simulateSignal(signal, price);

    // update UI & redraw charts
    renderAll();
    scheduleSave();
  }

  function computeRSI(period) {
    if (priceOnlyHistory.length < period + 1) return null;
    const slice = priceOnlyHistory.slice(-period - 1);
    let gains = 0, losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i] - slice[i-1];
      if (d > 0) gains += d;
      else losses += -d;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return rsi;
  }

  function decideSignal(emaS, emaL, rsi) {
    if (emaS == null || emaL == null) return "WARMUP";
    // Simple crossover + RSI edges
    let sig = "HOLD";
    if (emaS > emaL) sig = "BUY";
    else if (emaS < emaL) sig = "SELL";
    // RSI influence
    if (rsi !== null) {
      if (rsi < 20) sig = "BUY";
      if (rsi > 80) sig = "SELL";
    }
    return sig;
  }

  // ---------- Simulation: buy/sell logic ----------
  function simulateSignal(signal, price) {
    if (!Number.isFinite(price)) return;
    const ts = nowTs();
    // simple all-in/all-out strategy
    if (signal === "BUY" && sim.holdings === 0) {
      // buy with full balance
      const qty = sim.balance / price;
      if (qty > 0) {
        sim.trades.unshift({ type: "BUY", price, ts });
        sim.holdings = qty;
        sim.balance = 0;
      }
    } else if (signal === "SELL" && sim.holdings > 0) {
      const proceeds = sim.holdings * price;
      sim.trades.unshift({ type: "SELL", price, ts });
      sim.balance = proceeds;
      sim.holdings = 0;
    }
    const value = sim.balance + sim.holdings * price;
    sim.portfolioHistory.unshift({ ts, value });
    if (sim.portfolioHistory.length > settings.maxHistory) sim.portfolioHistory.pop();
  }

  // ---------- Rendering UI ----------
  const elPrice = document.getElementById("pos-price");
  const elSignal = document.getElementById("pos-signal");
  const elEmaShort = document.getElementById("pos-ema-short");
  const elEmaLong = document.getElementById("pos-ema-long");
  const elRsi = document.getElementById("pos-rsi");
  const elSelectorLabel = document.getElementById("pos-selector");
  const elHistorySize = document.getElementById("pos-history-size");
  const elAnalytics = document.getElementById("pos-analytics");
  const elPriceChart = document.getElementById("pos-price-chart");
  const elPortfolioChart = document.getElementById("pos-portfolio-chart");
  const priceCtx = elPriceChart.getContext("2d");
  const portCtx = elPortfolioChart.getContext("2d");
  const elTrades = document.getElementById("pos-trades");
  const elBalance = document.getElementById("pos-balance");
  const elHoldings = document.getElementById("pos-holdings");
  const elValue = document.getElementById("pos-value");

  function renderAll() {
    // price
    const last = priceOnlyHistory[priceOnlyHistory.length - 1];
    elPrice.textContent = Number.isFinite(last) ? last.toPrecision(8) : "—";

    // indicators
    elEmaShort.textContent = emaShort ? Number(emaShort).toFixed(8) : "—";
    elEmaLong.textContent = emaLong ? Number(emaLong).toFixed(8) : "—";
    const rsi = computeRSI(settings.rsiPeriod);
    elRsi.textContent = rsi !== null ? Number(rsi).toFixed(2) : "—";

    // signal
    elSignal.textContent = lastSignal;
    elSignal.style.color = lastSignal === "BUY" ? "#00d97a" : lastSignal === "SELL" ? "#ff5a5a" : "#cfcfcf";

    // metadata
    elSelectorLabel.textContent = selector ? selector : "auto";
    elHistorySize.textContent = priceOnlyHistory.length;

    // analytics
    if (settings.showAnalytics) {
      elAnalytics.style.display = "block";
      drawPriceChart();
      drawPortfolioChart();
      renderSimStats();
      renderTrades();
    } else {
      elAnalytics.style.display = "none";
    }
  }

  function drawPriceChart() {
    const data = priceOnlyHistory.slice(-300);
    if (data.length < 2) {
      priceCtx.clearRect(0,0,elPriceChart.width,elPriceChart.height);
      return;
    }
    const w = elPriceChart.width, h = elPriceChart.height;
    priceCtx.clearRect(0,0,w,h);
    // scale
    const min = Math.min(...data), max = Math.max(...data);
    // draw grid lightly
    priceCtx.globalAlpha = 0.06;
    priceCtx.fillStyle = "#fff";
    priceCtx.fillRect(0,0,w,h);
    priceCtx.globalAlpha = 1;
    // line
    priceCtx.beginPath();
    data.forEach((p, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((p - min) / (max - min || 1)) * h;
      if (i === 0) priceCtx.moveTo(x,y); else priceCtx.lineTo(x,y);
    });
    priceCtx.strokeStyle = "#00d97a";
    priceCtx.lineWidth = 1.6;
    priceCtx.stroke();

    // draw EMA overlays thin
    // compute EMA arrays for overlay (simple)
    try {
      const shortArr = computeArrayEMA(data, settings.emaShort);
      const longArr = computeArrayEMA(data, settings.emaLong);
      // short
      priceCtx.beginPath();
      shortArr.forEach((p, i) => {
        const x = (i / (shortArr.length - 1)) * w;
        const y = h - ((p - min) / (max - min || 1)) * h;
        if (i === 0) priceCtx.moveTo(x,y); else priceCtx.lineTo(x,y);
      });
      priceCtx.strokeStyle = "rgba(0,217,122,0.6)";
      priceCtx.lineWidth = 1;
      priceCtx.stroke();
      // long
      priceCtx.beginPath();
      longArr.forEach((p, i) => {
        const x = (i / (longArr.length - 1)) * w;
        const y = h - ((p - min) / (max - min || 1)) * h;
        if (i === 0) priceCtx.moveTo(x,y); else priceCtx.lineTo(x,y);
      });
      priceCtx.strokeStyle = "rgba(255,90,90,0.6)";
      priceCtx.lineWidth = 1;
      priceCtx.stroke();
    } catch(e) {}
  }

  function drawPortfolioChart() {
    const hist = sim.portfolioHistory.slice(0, 300).map(s => s.value).reverse(); // newest first in array; reverse to old->new
    if (!hist || hist.length < 2) {
      portCtx.clearRect(0,0,elPortfolioChart.width,elPortfolioChart.height);
      return;
    }
    const w = elPortfolioChart.width, h = elPortfolioChart.height;
    portCtx.clearRect(0,0,w,h);
    const min = Math.min(...hist), max = Math.max(...hist);
    portCtx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / (hist.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * h;
      if (i === 0) portCtx.moveTo(x,y); else portCtx.lineTo(x,y);
    });
    portCtx.strokeStyle = "#ffd166";
    portCtx.lineWidth = 1.6;
    portCtx.stroke();
  }

  function renderSimStats() {
    elBalance.textContent = sim.balance ? "$" + Number(sim.balance).toFixed(2) : "$0.00";
    elHoldings.textContent = sim.holdings ? Number(sim.holdings).toFixed(6) : "0";
    const last = priceOnlyHistory[priceOnlyHistory.length - 1] || 0;
    const value = sim.balance + sim.holdings * last;
    elValue.textContent = "$" + Number(value).toFixed(2);
  }

  function renderTrades() {
    elTrades.innerHTML = "";
    if (!sim.trades || sim.trades.length === 0) {
      elTrades.innerHTML = `<div style="opacity:0.7">No simulated trades yet.</div>`;
      return;
    }
    sim.trades.slice(0, 200).forEach(t => {
      const d = new Date(t.ts);
      const row = document.createElement("div");
      row.style.padding = "4px 0";
      row.style.borderBottom = "1px dashed rgba(255,255,255,0.02)";
      row.innerHTML = `<div style="font-weight:700; color:${t.type === 'BUY' ? '#00d97a' : '#ff5a5a'}">${t.type}</div>
        <div style="font-size:12px; color:#cfcfcf">${t.price.toPrecision(8)} — ${d.toLocaleString()}</div>`;
      elTrades.appendChild(row);
    });
  }

  function computeArrayEMA(arr, period) {
    if (!arr || arr.length === 0) return [];
    const out = [];
    let prev = null;
    const k = 2 / (period + 1);
    for (let i = 0; i < arr.length; i++) {
      const price = arr[i];
      if (prev === null) {
        // initial: SMA of first `period` or current slice
        const slice = arr.slice(Math.max(0, i - period + 1), i + 1);
        const avg = slice.reduce((a,b)=>a+b,0) / slice.length;
        prev = avg;
      } else {
        prev = (price - prev) * k + prev;
      }
      out.push(prev);
    }
    return out;
  }

  // ---------- Settings UI (settings modal) ----------
  // We'll create a simple settings overlay panel when user clicks gear button.
  const settingsBtn = document.getElementById("pos-settings-btn");
  let settingsPanel = null;
  settingsBtn.addEventListener("click", () => {
    if (settingsPanel) {
      settingsPanel.remove();
      settingsPanel = null;
      return;
    }
    settingsPanel = document.createElement("div");
    settingsPanel.style.cssText = `
      position:fixed; right:340px; top:12px; width:300px; z-index:2147483647;
    `;
    settingsPanel.innerHTML = `
      <div style="background:rgba(16,16,20,0.96); color:#eee; border-radius:10px; padding:12px; box-shadow:0 12px 40px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.03); font-size:13px;">
        <div style="font-weight:700; margin-bottom:8px">Overlay Settings</div>
        <label style="display:block; margin-bottom:6px;"><input type="checkbox" id="s-sim" ${settings.simulateTrading ? "checked": ""}/> Enable Fake Trading (Sim)</label>
        <label style="display:block; margin-bottom:6px;"><input type="checkbox" id="s-analytics" ${settings.showAnalytics ? "checked": ""}/> Show Analytics</label>
        <div style="display:flex; gap:6px; margin-top:8px;">
          <div style="flex:1">
            <div style="font-size:12px; color:#9aa">EMA short</div>
            <input id="s-ema-short" type="number" min="2" max="100" value="${settings.emaShort}" style="width:100%; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit"/>
          </div>
          <div style="flex:1">
            <div style="font-size:12px; color:#9aa">EMA long</div>
            <input id="s-ema-long" type="number" min="3" max="200" value="${settings.emaLong}" style="width:100%; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit"/>
          </div>
        </div>

        <div style="margin-top:8px; display:flex; gap:6px;">
          <div style="flex:1">
            <div style="font-size:12px; color:#9aa">RSI period</div>
            <input id="s-rsi" type="number" min="6" max="40" value="${settings.rsiPeriod}" style="width:100%; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit"/>
          </div>
          <div style="flex:1">
            <div style="font-size:12px; color:#9aa">Poll(ms)</div>
            <input id="s-poll" type="number" min="500" max="60000" value="${settings.pollIntervalMs}" style="width:100%; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit"/>
          </div>
        </div>

        <div style="margin-top:8px; display:flex; gap:6px;">
          <button id="s-save" style="flex:1; padding:8px; border-radius:8px; border:0; background:#0b84ff; color:white; cursor:pointer">Save</button>
          <button id="s-reset" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06); background:transparent; color:inherit; cursor:pointer">Reset Data</button>
        </div>

        <div style="margin-top:8px; font-size:12px; color:#9aa">Selector: <span id="settings-selector">${selector || "auto"}</span></div>
      </div>
    `;
    document.body.appendChild(settingsPanel);

    // wire handlers
    settingsPanel.querySelector("#s-save").addEventListener("click", () => {
      const sSim = !!settingsPanel.querySelector("#s-sim").checked;
      const sAnalytics = !!settingsPanel.querySelector("#s-analytics").checked;
      const sEmaS = parseInt(settingsPanel.querySelector("#s-ema-short").value) || settings.emaShort;
      const sEmaL = parseInt(settingsPanel.querySelector("#s-ema-long").value) || settings.emaLong;
      const sRsi = parseInt(settingsPanel.querySelector("#s-rsi").value) || settings.rsiPeriod;
      const sPoll = parseInt(settingsPanel.querySelector("#s-poll").value) || settings.pollIntervalMs;

      settings.simulateTrading = sSim;
      settings.showAnalytics = sAnalytics;
      settings.emaShort = sEmaS;
      settings.emaLong = sEmaL;
      settings.rsiPeriod = sRsi;
      settings.pollIntervalMs = sPoll;

      // update UI & save
      document.getElementById("pos-selector").textContent = selector || "auto";
      document.getElementById("pos-history-size").textContent = priceOnlyHistory.length;
      // hide/show analytics area
      if (settings.showAnalytics) document.getElementById("pos-analytics").style.display = "block"; else document.getElementById("pos-analytics").style.display = "none";

      scheduleSave();
      settingsPanel.remove();
      settingsPanel = null;
    });

    settingsPanel.querySelector("#s-reset").addEventListener("click", () => {
      // reset sim & history but keep settings
      priceHistory = [];
      priceOnlyHistory = [];
      emaShort = null; emaLong = null;
      sim = { balance: settings.simStartBalance, holdings: 0, trades: [], portfolioHistory: [] };
      document.getElementById("pos-history-size").textContent = 0;
      scheduleSave();
      renderAll();
    });
  });

  // ---------- Reset button ----------
  document.getElementById("pos-reset-btn").addEventListener("click", () => {
    // remove saved selector for this token and re-autodetect
    selector = null;
    document.getElementById("pos-selector").textContent = "auto";
    if (observer) { observer.disconnect(); observer = null; }
    startGeneralPoller();
    scheduleSave();
  });

  // ---------- Initial binding logic ----------
  // If a saved selector exists from persistence, try to bind to it. Else try auto-detect.
  (async () => {
    if (selector) {
      bindToSelector(selector);
    } else {
      const auto = tryAutoDetectSelector();
      if (auto) bindToSelector(auto);
      else startGeneralPoller();
    }
  })();

  // ---------- Ensure overlay sync with site changes (navigation) ----------
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // new page: re-detect token name and tokenKey is dynamic per page reload
      document.getElementById("pos-token").textContent = `(${detectTokenName() || "unknown"})`;
      // bind again (selector may be invalid on new page)
      if (selector) bindToSelector(selector);
      else {
        const auto = tryAutoDetectSelector();
        if (auto) bindToSelector(auto);
      }
    }
  }, 1000);

  // ---------- Start a backup poller for price (in case mutation observer misses updates) ----------
  setInterval(() => {
    if (!selector) return;
    const el = document.querySelector(selector);
    if (!el) return;
    const val = parsePriceText(el.textContent || el.innerText || "");
    if (Number.isFinite(val)) {
      const last = priceOnlyHistory[priceOnlyHistory.length - 1];
      // push only if changed
      if (!Number.isFinite(last) || Math.abs(last - val) > 1e-12) pushPrice(val);
    }
  }, settings.pollIntervalMs || 2000);

  // ---------- Export helpers (optional) ----------
  // You can paste below code in console to get saved state:
  // chrome.storage.local.get(null, console.log)

  // ---------- End of content script ----------
})();
