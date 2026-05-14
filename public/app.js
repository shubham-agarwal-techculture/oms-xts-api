const socket = io();

const state = {
    positions: [],
    alerts: [],
    orders: [],
    history: [],
    prices: {}
};

// Elements
const positionsBody = document.getElementById('positions-body');
const alertsLog = document.getElementById('alerts-log');
const ordersLog = document.getElementById('orders-log');
const historyLog = document.getElementById('history-log');
const totalPnlEl = document.getElementById('total-pnl');
const activePosCountEl = document.getElementById('active-positions-count');
const connectionStatusEl = document.getElementById('connection-status');

// Socket Event Handlers
socket.on('connect', () => {
    connectionStatusEl.textContent = 'CONNECTED';
    connectionStatusEl.className = 'value connected';
});

socket.on('disconnect', () => {
    connectionStatusEl.textContent = 'DISCONNECTED';
    connectionStatusEl.className = 'value disconnected';
});

socket.on('state', (data) => {
    state.positions = data.positions || [];
    state.alerts = data.alerts || [];
    state.orders = data.orders || [];
    state.history = data.historicalPositions || [];
    renderAll();
});

socket.on('alert', (alert) => {
    state.alerts.unshift(alert);
    if (state.alerts.length > 50) state.alerts.pop();
    renderAlerts();
});

socket.on('order', (order) => {
    state.orders.unshift(order);
    if (state.orders.length > 50) state.orders.pop();
    renderOrders();
});

socket.on('positionUpdate', (pos) => {
    const index = state.positions.findIndex(p => p.symbol === pos.symbol);
    if (pos.qty === 0) {
        if (index !== -1) state.positions.splice(index, 1);
    } else {
        if (index !== -1) state.positions[index] = pos;
        else state.positions.push(pos);
    }
    renderPositions();
});

socket.on('priceUpdate', ({ symbol, price }) => {
    state.prices[symbol] = price;
    updatePnlDisplay();
});

// Render Functions
function renderAll() {
    renderPositions();
    renderAlerts();
    renderOrders();
    renderHistory();
}

function renderPositions() {
    positionsBody.innerHTML = state.positions.map(pos => {
        const ltp = state.prices[pos.symbol] || pos.avgPrice;
        const pnl = (ltp - pos.avgPrice) * pos.qty;
        const pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        
        return `
            <tr>
                <td><strong>${pos.symbol}</strong></td>
                <td>${pos.qty}</td>
                <td>${pos.avgPrice.toFixed(2)}</td>
                <td id="ltp-${pos.symbol}">${ltp.toFixed(2)}</td>
                <td class="${pnlClass}" id="pnl-${pos.symbol}">₹${pnl.toFixed(2)}</td>
                <td>
                    <button class="btn-squareoff" onclick="squareOff('${pos.symbol}')">Square Off</button>
                </td>
            </tr>
        `;
    }).join('');
    
    activePosCountEl.textContent = state.positions.length;
    updatePnlDisplay();
}

function renderAlerts() {
    alertsLog.innerHTML = state.alerts.map(alert => `
        <div class="log-entry">
            <div class="meta">
                <span class="time">${new Date(alert.timestamp).toLocaleTimeString()}</span>
                <span class="action">${alert.action} ${alert.quantity}</span>
            </div>
            <div class="content">${alert.symbol} received from ${alert.source || 'REST'}</div>
        </div>
    `).join('');
}

function renderOrders() {
    ordersLog.innerHTML = state.orders.map(order => `
        <div class="log-entry ${order.signal?.action?.toLowerCase()}">
            <div class="meta">
                <span class="time">${new Date(order.timestamp).toLocaleTimeString()}</span>
                <span class="badge badge-${order.status.toLowerCase()}">${order.status}</span>
            </div>
            <div class="content">${order.signal?.action} ${order.signal?.quantity} ${order.signal?.symbol} @ ${order.price || 'MKT'}</div>
        </div>
    `).join('');
}

function renderHistory() {
    historyLog.innerHTML = state.history.map(item => `
        <div class="log-entry">
            <div class="meta">
                <span class="time">${new Date(item.timestamp).toLocaleTimeString()}</span>
                <span class="${item.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">₹${item.pnl.toFixed(2)}</span>
            </div>
            <div class="content">Closed ${item.qty} ${item.symbol} (In: ${item.entryPrice.toFixed(2)}, Out: ${item.exitPrice.toFixed(2)})</div>
        </div>
    `).join('');
}

function updatePnlDisplay() {
    let totalPnl = 0;
    state.positions.forEach(pos => {
        const ltp = state.prices[pos.symbol] || pos.avgPrice;
        const pnl = (ltp - pos.avgPrice) * pos.qty;
        totalPnl += pnl;
        
        // Live update individual rows if they exist
        const ltpEl = document.getElementById(`ltp-${pos.symbol}`);
        const pnlEl = document.getElementById(`pnl-${pos.symbol}`);
        if (ltpEl) ltpEl.textContent = ltp.toFixed(2);
        if (pnlEl) {
            pnlEl.textContent = `₹${pnl.toFixed(2)}`;
            pnlEl.className = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        }
    });
    
    totalPnlEl.textContent = `₹${totalPnl.toFixed(2)}`;
    totalPnlEl.className = `value ${totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
}

async function squareOff(symbol) {
    if (!confirm(`Are you sure you want to square off ${symbol}?`)) return;
    
    try {
        const response = await fetch(`/api/squareoff/${symbol}`, { method: 'POST' });
        const result = await response.json();
        if (result.success) {
            console.log('Square off triggered');
        } else {
            alert('Square off failed: ' + result.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}
