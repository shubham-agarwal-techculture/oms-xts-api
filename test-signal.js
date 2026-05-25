const axios = require('axios');

const testSignal = {
    symbol: 'nifty',
    action: 'BUY',
    quantity: 1,
    position: 'long',
    orderType: 'MARKET',
    productType: 'MIS'
};

console.log('Sending test signal to OMS...');
console.log('Test signal:', JSON.stringify(testSignal, null, 2));

axios.post('http://localhost:5001/signal', testSignal)
    .then(response => {
        console.log('✅ Signal sent successfully!');
        console.log('Response:', JSON.stringify(response.data, null, 2));
    })
    .catch(error => {
        console.error('❌ Failed to send signal:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
    });
