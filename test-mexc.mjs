import ccxt from 'ccxt';

const exchange = new ccxt.mexc({
  enableRateLimit: true,
});

async function test() {
  try {
    console.log('Testing MEXC connection...');
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('✅ BTC/USDT Price:', ticker.last);
    
    // Test with BANK/USDT
    try {
      const bankTicker = await exchange.fetchTicker('BANK/USDT');
      console.log('✅ BANK/USDT Price:', bankTicker.last);
    } catch (bankError) {
      console.log('❌ BANK/USDT error:', bankError.message);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}
test();
