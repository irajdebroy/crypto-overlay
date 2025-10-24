class TradingSignalOverlay {
    constructor() {
        this.overlay = null;
        this.signals = [];
        this.isVisible = true;
        this.position = { x: 20, y: 20 };
        this.init();
    }

    init() {
        this.createOverlay();
        this.loadSettings();
        this.startSignalGeneration();
        this.makeDraggable();
    }

    createOverlay() {
        // Create overlay container
        this.overlay = document.createElement('div');
        this.overlay.id = 'trading-signal-overlay';
        this.overlay.innerHTML = `
            <div class="signal-header">
                <span>📈 Trading Signals</span>
                <div class="header-controls">
                    <button class="minimize-btn">−</button>
                    <button class="close-btn">×</button>
                </div>
            </div>
            <div class="signal-content">
                <div class="signal-list"></div>
                <div class="controls">
                    <button class="refresh-btn">Refresh</button>
                    <button class="clear-btn">Clear</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.overlay);
        this.attachEventListeners();
    }

    attachEventListeners() {
        // Close button
        this.overlay.querySelector('.close-btn').addEventListener('click', () => {
            this.overlay.style.display = 'none';
        });

        // Minimize button
        this.overlay.querySelector('.minimize-btn').addEventListener('click', () => {
            const content = this.overlay.querySelector('.signal-content');
            content.style.display = content.style.display === 'none' ? 'block' : 'none';
        });

        // Refresh button
        this.overlay.querySelector('.refresh-btn').addEventListener('click', () => {
            this.generateMockSignals();
        });

        // Clear button
        this.overlay.querySelector('.clear-btn').addEventListener('click', () => {
            this.signals = [];
            this.updateDisplay();
        });
    }

    makeDraggable() {
        const header = this.overlay.querySelector('.signal-header');
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragOffset.x = e.clientX - this.overlay.offsetLeft;
            dragOffset.y = e.clientY - this.overlay.offsetTop;
            this.overlay.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            this.overlay.style.left = (e.clientX - dragOffset.x) + 'px';
            this.overlay.style.top = (e.clientY - dragOffset.y) + 'px';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            this.overlay.style.cursor = 'grab';
            this.savePosition();
        });

        header.style.cursor = 'grab';
    }

    async generateMockSignals() {
        // Mock data - replace with real API calls later
        const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT', 'SOL/USDT', 'DOT/USDT'];
        const signalTypes = ['BUY', 'SELL', 'HOLD'];
        const reasons = [
            'RSI Oversold',
            'MACD Bullish Crossover',
            'Support Level Bounce',
            'Resistance Breakout',
            'Volume Spike',
            'Social Sentiment Positive',
            'News Catalyst'
        ];

        this.signals = [];

        symbols.forEach(symbol => {
            const signalType = signalTypes[Math.floor(Math.random() * signalTypes.length)];
            if (signalType !== 'HOLD') {
                const confidence = Math.floor(Math.random() * 30) + 70; // 70-100%
                const reason = reasons[Math.floor(Math.random() * reasons.length)];
                
                this.signals.push({
                    symbol,
                    type: signalType,
                    confidence,
                    reason,
                    timestamp: new Date().toLocaleTimeString()
                });
            }
        });

        this.updateDisplay();
    }

    updateDisplay() {
        const signalList = this.overlay.querySelector('.signal-list');
        signalList.innerHTML = '';

        if (this.signals.length === 0) {
            signalList.innerHTML = '<div class="no-signals">No signals detected</div>';
            return;
        }

        this.signals.forEach(signal => {
            const signalElement = document.createElement('div');
            signalElement.className = `signal-item ${signal.type.toLowerCase()}`;
            
            const confidenceColor = signal.confidence >= 85 ? 'high' : 
                                  signal.confidence >= 75 ? 'medium' : 'low';
            
            signalElement.innerHTML = `
                <div class="symbol">${signal.symbol}</div>
                <div class="signal-type ${signal.type.toLowerCase()}">${signal.type}</div>
                <div class="confidence ${confidenceColor}">${signal.confidence}%</div>
                <div class="reason">${signal.reason}</div>
                <div class="timestamp">${signal.timestamp}</div>
            `;

            signalList.appendChild(signalElement);
        });
    }

    loadSettings() {
        chrome.storage.local.get(['overlayPosition'], (result) => {
            if (result.overlayPosition) {
                this.overlay.style.left = result.overlayPosition.x + 'px';
                this.overlay.style.top = result.overlayPosition.y + 'px';
            }
        });
    }

    savePosition() {
        chrome.storage.local.set({
            overlayPosition: {
                x: this.overlay.offsetLeft,
                y: this.overlay.offsetTop
            }
        });
    }

    startSignalGeneration() {
        // Generate initial signals
        this.generateMockSignals();
        
        // Update every 30 seconds
        setInterval(() => {
            this.generateMockSignals();
        }, 30000);
    }
}

// Initialize when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new TradingSignalOverlay();
    });
} else {
    new TradingSignalOverlay();
}
