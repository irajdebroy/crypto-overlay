// content.js
// Inject overlay UI and price-capture + indicator logic.
// No external libs.

(function() {
  if (window.__price_overlay_installed) return;
  window.__price_overlay_installed = true;

  // CONFIG
  const POLL_INTERVAL_MS = 5000;    // how often to read price (5s)
  const MAX_POINTS = 500;          // max history points to keep
  const EMA_SHORT = 12;
  const EMA_LONG = 26;
  const RSI_PERIOD = 14;
  const PERCENT_CHANGE_ALERT = 2;  // not used for signal but displayed

  // Create overlay UI
  const overlay = document.createElement('div');
  overlay.id = 'price-overlay';
  overlay.innerHTML = `
    <div class="po-header">
      <div class="po-title">Signal Overlay</div>
      <div class="po-controls">
        <button id="po-toggle">Hide</button>
        <button id="po-select">Select Price Element</button>
        <button id="po-reset">Reset</button>
      </div>
    </div>
    <div class="po-body">
      <div>Detected price: <span id="po-price">—</span></div>
      <div>EMA(${EMA_SHORT}): <span id="po-ema-short">—</span></div>
      <div>EMA(${EMA_LONG}): <span id="po-ema-long">—</span></div>
      <div>RSI(${RSI_PERIOD}): <span id="po-rsi">—</span></div>
      <div>Signal: <span id="po-signal">—</span></div>
      <div class="po-small">Source selector: <span id="po-selector">auto</span></div>
      <div class="po-small">History size: <span id="po-history-size">0</span></div>
      <div class="po-footer">Note: informational only.</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Make overlay draggable (simple)
  let drag = false, offsetX=0, offsetY=0;
  const header = overlay.querySelector('.po-header');
  header.addEventListener('mousedown', e => {
    drag = true;
    offsetX = e.clientX - overlay.offsetLeft;
    offsetY = e.clientY - overlay.offsetTop;
    overlay.style.transition = 'none';
  });
  document.addEventListener('mouseup', () => { drag = false; overlay.style.transition = ''; });
  document.addEventListener('mousemove', e=>{
    if (!drag) return;
    overlay.style.left = (e.clientX - offsetX) + 'px';
    overlay.style.top = (e.clientY - offsetY) + 'px';
  });

  // Elements
  const elPrice = document.getElementById('po-price');
  const elEMAS = document.getElementById('po-ema-short');
  const elEMAL = document.getElementById('po-ema-long');
  const elRSI = document.getElementById('po-rsi');
  const elSignal = document.getElementById('po-signal');
  const elSelector = document.getElementById('po-selector');
  const elHistorySize = document.getElementById('po-history-size');

  // Buttons
  document.getElementById('po-toggle').addEventListener('click', () => {
    const body = overlay.querySelector('.po-body');
    const btn = document.getElementById('po-toggle');
    if (body.style.display === 'none') {
      body.style.display = '';
      btn.textContent = 'Hide';
    } else {
      body.style.display = 'none';
      btn.textContent = 'Show';
    }
  });

  document.getElementById('po-reset').addEventListener('click', ()=> {
    priceHistory = [];
    emaShort = null;
    emaLong = null;
    elSelector.textContent = selector || 'auto';
    elHistorySize.textContent = priceHistory.length;
  });

  // Price element selector tool
  let selecting = false;
  let selector = null; // CSS selector string
  document.getElementById('po-select').addEventListener('click', () => {
    selecting = !selecting;
    const btn = document.getElementById('po-select');
    if (selecting) {
      btn.textContent = 'Cancel select';
      startSelectionMode();
    } else {
      btn.textContent = 'Select Price Element';
      stopSelectionMode();
    }
  });

  function uniqueSelectorFromElement(el) {
    if (!el) return null;
    // Build a selector by walking up until body. Try to make reasonably unique.
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        part += '#' + el.id;
        parts.unshift(part);
        break;
      } else {
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).slice(0,2).join('.');
          if (cls) part += '.' + cls;
        }
        // nth-child fallback
        const parent = el.parentNode;
        if (parent) {
          const children = Array.from(parent.children);
          const idx = children.indexOf(el);
          part += `:nth-child(${idx+1})`;
        }
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  let lastHighlighted = null;
  function startSelectionMode() {
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mouseover', selectionMouseOver);
    document.addEventListener('click', selectionClick, true);
  }
  function stopSelectionMode() {
    document.body.style.cursor = '';
    document.removeEventListener('mouseover', selectionMouseOver);
    document.removeEventListener('click', selectionClick, true);
    if (lastHighlighted) {
      lastHighlighted.style.outline = '';
      lastHighlighted = null;
    }
    selecting = false;
    document.getElementById('po-select').textContent = 'Select Price Element';
  }
  function selectionMouseOver(e) {
    if (lastHighlighted) lastHighlighted.style.outline = '';
    lastHighlighted = e.target;
    lastHighlighted.style.outline = '2px solid #ffcc00';
  }
  function selectionClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    selector = uniqueSelectorFromElement(el);
    elSelector.textContent = selector;
    stopSelectionMode();
    return false;
  }

  // Attempt auto-detection of price element using common selectors
  const candidateSelectors = [
    '[data-testid="price"]',
    '.price',
    '.token-price',
    '.pair-price',
    '.text-price',
    '.priceValue',
    '.current-price',
    '[class*="price"]',
    '[class*="Price"]',
    '.chakra-text', // sometimes used with specific children
    'h1', 'h2', 'h3'
  ];

  function tryFindPriceElement() {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    for (const s of candidateSelectors) {
      const el = document.querySelector(s);
      if (el && /\d/.test(el.textContent)) return el;
    }
    // fallback: find largest text node that resembles price (contains $ or decimal)
    const allTextElems = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3'));
    let best = null;
    for (const el of allTextElems) {
      const text = el.textContent.trim();
      if (!text) continue;
      if (/\$?\d{1,3}(,\d{3})*(\.\d+)?/.test(text) || /\d+\.\d{2,}/.test(text)) {
        // Heuristic: prefer short text
        if (!best || text.length < best.text.length) best = {el, text};
      }
    }
    return best ? best.el : null;
  }

  // Price parsing helper: extract numeric value from a text string
  function parsePriceText(text) {
    if (!text) return NaN;
    // remove commas, currency symbols, spaces
    const cleaned = text.replace(/[,\s]/g, '').replace(/[^0-9.\-eE]/g,'');
    const num = parseFloat(cleaned);
    return isFinite(num) ? num : NaN;
  }

  // History and indicators
  let priceHistory = [];
  let emaShort = null;
  let emaLong = null;

  function updateHistory(price) {
    if (!isFinite(price)) return;
    priceHistory.push(price);
    if (priceHistory.length > MAX_POINTS) priceHistory.shift();
    document.getElementById('po-history-size').textContent = priceHistory.length;
  }

  // Compute simple EMA given period and previous EMA
  function computeEMA(prices, period, prevEMA=null) {
    if (prices.length === 0) return null;
    const k = 2 / (period + 1);
    if (prevEMA === null) {
      // initialize with simple SMA of first period or whole array if smaller
      const slice = prices.slice(Math.max(0, prices.length - period));
      const sum = slice.reduce((a,b)=>a+b,0);
      return sum / slice.length;
    } else {
      const price = prices[prices.length - 1];
      return (price - prevEMA) * k + prevEMA;
    }
  }

  // Compute RSI using standard method over last N.
  function computeRSI(period) {
    if (priceHistory.length < period + 1) return null;
    const slice = priceHistory.slice(priceHistory.length - (period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const change = slice[i] - slice[i-1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return rsi;
  }

  let lastSignal = 'HOLD';
  let lastEMAShortVal = null;
  let lastEMALongVal = null;

  function evaluateSignal() {
    if (emaShort === null || emaLong === null) return 'WARMUP';
    // check crossovers based on previous EMA values
    let signal = 'HOLD';
    if (lastEMAShortVal !== null && lastEMALongVal !== null) {
      // previous relationship:
      const prevDiff = lastEMAShortVal - lastEMALongVal;
      const curDiff = emaShort - emaLong;
      if (prevDiff <= 0 && curDiff > 0) signal = 'BUY';      // cross up
      else if (prevDiff >= 0 && curDiff < 0) signal = 'SELL'; // cross down
      else signal = 'HOLD';
    }
    // also use RSI extremes to bias
    const rsi = computeRSI(RSI_PERIOD);
    if (rsi !== null) {
      if (rsi < 25 && signal === 'HOLD') signal = 'BUY';
      if (rsi > 75 && signal === 'HOLD') signal = 'SELL';
    }
    lastEMAShortVal = emaShort;
    lastEMALongVal = emaLong;
    lastSignal = signal;
    return signal;
  }

  // Poll loop
  async function pollPrice() {
    try {
      const el = tryFindPriceElement();
      if (!el) {
        elPrice.textContent = 'no price element';
        elSelector.textContent = selector || 'auto';
        setTimeout(pollPrice, POLL_INTERVAL_MS);
        return;
      }
      // get text content
      let text = el.textContent || el.innerText || '';
      // some sites update price in attributes; try dataset
      if (!text || !/\d/.test(text)) {
        // try value attributes
        text = el.value || el.getAttribute('data-price') || el.getAttribute('data-value') || text;
      }
      const price = parsePriceText(text);
      if (!isFinite(price)) {
        // try innerText of children first that look numeric
        const children = Array.from(el.querySelectorAll('*'));
        for (const child of children) {
          const t = (child.textContent||'').trim();
          const p = parsePriceText(t);
          if (isFinite(p)) { priceHistory && priceHistory; /*no-op*/ }
        }
      }

      if (isFinite(price)) {
        elPrice.textContent = price;
        updateHistory(price);
        // update EMAs
        emaShort = computeEMA(priceHistory, EMA_SHORT, emaShort);
        emaLong = computeEMA(priceHistory, EMA_LONG, emaLong);
        elEMAS.textContent = emaShort ? emaShort.toFixed(8) : '—';
        elEMAL.textContent = emaLong ? emaLong.toFixed(8) : '—';
        const rsi = computeRSI(RSI_PERIOD);
        elRSI.textContent = rsi ? rsi.toFixed(2) : '—';

        // decide signal
        const sig = evaluateSignal();
        elSignal.textContent = sig;
        elSignal.className = 'po-signal-' + sig.toLowerCase();
      } else {
        elPrice.textContent = 'parse fail';
      }
    } catch (err) {
      console.error('overlay poll error', err);
    } finally {
      setTimeout(pollPrice, POLL_INTERVAL_MS);
    }
  }

  // Initial startup
  elSelector.textContent = selector || 'auto';
  pollPrice();

  // Small keyboard shortcut: press 'O' to toggle overlay
  document.addEventListener('keydown', (e)=>{
    if (e.key === 'o' || e.key === 'O') {
      const body = overlay.querySelector('.po-body');
      const btn = document.getElementById('po-toggle');
      if (body.style.display === 'none') { body.style.display = ''; btn.textContent = 'Hide'; }
      else { body.style.display = 'none'; btn.textContent = 'Show'; }
    }
  });

})();
