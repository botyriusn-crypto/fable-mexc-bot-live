const ccxt = require('ccxt');
const exchange = new ccxt.mexc({
  enableRateLimit: true,
});

async function test() {
  try {
    console.log('Testing MEXC connection...');
    const ticker = await exchange.fetchTicker('BANK/USDT');
    console.log('Ticker response:', ticker);
    console.log('Price:', ticker.last);
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Full error:', error);
  }
}
test();
