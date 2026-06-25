/* =====================================================================
   MOTIONSALT — chart.js
   ─────────────────────────────────────────────────────────────────────
   Generates a candlestick chart screenshot using Puppeteer + Chart.js
   (CDN, no TradingView). Returns a PNG Buffer ready for Telegram.

   Public surface:
     generateChart(ws, symbol, tf, opts?) → Buffer (PNG)

   tf values: '1m' | '5m' | '15m' | '30m' | '1h'
   ===================================================================== */

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const Deriv     = require('./deriv');
const Logger    = require('./logger');

function ensureChromium() {
    try {
        puppeteer.executablePath();
        return;
    } catch (e) {
        Logger.info('[chart] no cached Chromium found - installing now (first chart request)');
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    }
}

/* Map human tf string → Deriv granularity in seconds + candle count */
const TF_MAP = {
    '1m':  { gran: 60,   count: 80 },
    '5m':  { gran: 300,  count: 80 },
    '15m': { gran: 900,  count: 60 },
    '30m': { gran: 1800, count: 60 },
    '1h':  { gran: 3600, count: 48 },
};

/* ─────────────────────────────────────────────────────────────────
   Build self-contained HTML with Chart.js CDN candlestick chart
   ───────────────────────────────────────────────────────────────── */
function buildHtml(candles, symbol, tf) {
    /* Convert candles → chartjs-chart-financial OHLC objects */
    const data = candles.map(c => ({
        x: c.epoch * 1000,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
    }));

    /* Price range for Y axis padding */
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const yMin   = (Math.min(...lows)  * 0.9995).toFixed(5);
    const yMax   = (Math.max(...highs) * 1.0005).toFixed(5);

    const lastPrice  = candles[candles.length - 1].close.toFixed(5);
    const firstPrice = candles[0].open;
    const change     = candles[candles.length - 1].close - firstPrice;
    const changePct  = ((change / firstPrice) * 100).toFixed(2);
    const changeStr  = `${change >= 0 ? '+' : ''}${change.toFixed(5)} (${changePct}%)`;
    const headerColor = change >= 0 ? '#26d07c' : '#ff4d6b';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d0d10;
    font-family: 'Segoe UI', system-ui, sans-serif;
    width: 900px;
    height: 520px;
    overflow: hidden;
  }
  #header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 18px 24px 10px;
  }
  #symbol {
    font-size: 18px;
    font-weight: 700;
    color: #f0f0f5;
    letter-spacing: 0.5px;
  }
  #tf-badge {
    font-size: 11px;
    font-weight: 600;
    color: #888;
    background: #1a1a22;
    border-radius: 4px;
    padding: 2px 7px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  #price {
    font-size: 22px;
    font-weight: 700;
    color: #f0f0f5;
    margin-left: auto;
  }
  #change {
    font-size: 13px;
    font-weight: 600;
    color: ${headerColor};
  }
  #watermark {
    position: absolute;
    bottom: 14px;
    right: 20px;
    font-size: 11px;
    color: #2a2a35;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  #chart-wrap {
    padding: 0 12px 12px;
    height: 440px;
  }
  canvas { display: block; }
</style>
</head>
<body>
<div id="header">
  <span id="symbol">${symbol}</span>
  <span id="tf-badge">${tf}</span>
  <span id="price">${lastPrice}</span>
  <span id="change">${changeStr}</span>
</div>
<div id="chart-wrap">
  <canvas id="chart"></canvas>
</div>
<div id="watermark">MOTIONSALT</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@0.1.1/dist/chartjs-chart-financial.min.js"></script>
<script>
const data = ${JSON.stringify(data)};

const ctx = document.getElementById('chart').getContext('2d');
const wrap = document.getElementById('chart-wrap');
const canvas = document.getElementById('chart');
canvas.width  = wrap.clientWidth;
canvas.height = wrap.clientHeight;

new Chart(ctx, {
  type: 'candlestick',
  data: {
    datasets: [{
      label: '${symbol}',
      data,
      color: {
        up:   '#26d07c',
        down: '#ff4d6b',
        unchanged: '#888888',
      },
      borderColor: {
        up:   '#26d07c',
        down: '#ff4d6b',
        unchanged: '#888888',
      },
    }]
  },
  options: {
    responsive: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: 'timeseries',
        time: { unit: 'minute' },
        grid: { color: '#1a1a22', drawBorder: false },
        ticks: {
          color: '#555',
          maxTicksLimit: 8,
          font: { size: 10 },
        },
        border: { color: '#1a1a22' },
      },
      y: {
        position: 'right',
        min: ${yMin},
        max: ${yMax},
        grid: { color: '#1a1a22', drawBorder: false },
        ticks: {
          color: '#555',
          maxTicksLimit: 6,
          font: { size: 10 },
          callback: v => v.toFixed(5),
        },
        border: { color: '#1a1a22' },
      }
    }
  }
});
</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────────────
   Main export
   ───────────────────────────────────────────────────────────────── */
async function generateChart(ws, symbol, tf = '1m') {
    const tfCfg = TF_MAP[tf] || TF_MAP['1m'];
    Logger.info(`[chart] fetching ${tfCfg.count} candles for ${symbol} @ ${tf}`);

    const candles = await Deriv.ticksHistory(ws, symbol, tfCfg.gran, tfCfg.count);
    if (!candles || candles.length < 5) {
        throw new Error(`Not enough candle data for ${symbol} (got ${candles ? candles.length : 0})`);
    }

    const html = buildHtml(candles, symbol, tf);

    ensureChromium();

    Logger.info('[chart] launching Puppeteer');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 2 });
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });

        /* Give Chart.js a tick to finish rendering */
        await page.evaluate(() => new Promise(r => setTimeout(r, 400)));

        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        Logger.info('[chart] screenshot captured');
        return buffer;
    } finally {
        await browser.close();
    }
}

module.exports = { generateChart, TF_MAP };
