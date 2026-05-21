// Theme Switcher & Persistence Logic
const themeToggleBtn = document.getElementById('theme-toggle');
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });
}

const socket = io();

/** Keep in sync with server `OMS_UI_STATE_WINDOW` default (500). */
const MAX_UI_ITEMS = 500;

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
    state.alerts = (data.alerts || []).reverse();
    state.orders = (data.orders || []).reverse();
    state.history = (data.historicalPositions || []).reverse();
    renderAll();
});

socket.on('alert', (alert) => {
    state.alerts.unshift(alert);
    if (state.alerts.length > MAX_UI_ITEMS) state.alerts.pop();
    renderAlerts();
    triggerFlicker(alertsLog);
});

socket.on('order', (order) => {
    state.orders.unshift(order);
    if (state.orders.length > MAX_UI_ITEMS) state.orders.pop();
    renderOrders();
    triggerFlicker(ordersLog);
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

socket.on('positionsSynced', (positions) => {
    state.positions = positions || [];
    renderPositions();
});

socket.on('historyUpdate', (item) => {
    state.history.unshift(item);
    if (state.history.length > MAX_UI_ITEMS) state.history.pop();
    renderHistory();
    triggerFlicker(historyLog);
});

// Render Functions
function renderAll() {
    renderPositions();
    renderAlerts();
    renderOrders();
    renderHistory();
}

function triggerFlicker(element) {
    element.classList.remove('log-flicker');
    void element.offsetWidth; // Trigger reflow
    element.classList.add('log-flicker');
    setTimeout(() => {
        element.classList.remove('log-flicker');
    }, 600);
}

function formatPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return n.toFixed(2);
}

function positionPnl(pos, ltp) {
    const avg = Number(pos.avgPrice);
    const last = Number(ltp);
    if (!Number.isFinite(avg) || avg <= 0 || !Number.isFinite(last) || last <= 0) {
        return null;
    }
    return (last - avg) * pos.qty;
}

function renderPositions() {
    positionsBody.innerHTML = state.positions.map(pos => {
        const ltp = state.prices[pos.symbol];
        const hasLtp = Number.isFinite(ltp) && ltp > 0;
        const ltpDisplay = hasLtp ? ltp : (Number(pos.avgPrice) > 0 ? pos.avgPrice : null);
        const pnl = positionPnl(pos, hasLtp ? ltp : null);
        const pnlClass = pnl == null ? '' : pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        const pnlText = pnl == null ? '—' : `₹${pnl.toFixed(2)}`;
        const side = pos.side || (pos.qty > 0 ? 'LONG' : pos.qty < 0 ? 'SHORT' : 'FLAT');
        const positionQty = Math.abs(pos.qty);
        const orderQty = pos.lastOrderQty != null ? pos.lastOrderQty : '—';
        const targetQty = pos.targetQty != null ? Math.abs(pos.targetQty) : '—';

        return `
            <tr>
                <td><strong>${pos.symbol}</strong></td>
                <td><span class="badge badge-${side.toLowerCase()}">${side}</span></td>
                <td class="qty-position">${positionQty}</td>
                <td class="qty-order">${orderQty}</td>
                <td class="qty-target">${targetQty}</td>
                <td>${formatPrice(pos.avgPrice)}</td>
                <td id="ltp-${pos.symbol}">${ltpDisplay != null ? ltpDisplay.toFixed(2) : '—'}</td>
                <td class="${pnlClass}" id="pnl-${pos.symbol}">${pnlText}</td>
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
                <span class="action">${alert.action}</span>
                <span class="qty-label">Signal Qty: ${alert.quantity}</span>
                ${alert.position ? `<span class="badge badge-info">${alert.position}</span>` : ''}
            </div>
            <div class="content">${alert.symbol || '—'} · target ${alert.position || '—'} position</div>
        </div>
    `).join('');
}

function renderOrders() {
    ordersLog.innerHTML = state.orders.map(order => `
        <div class="log-entry ${((order.signal || order).action || '').toLowerCase()}">
            <div class="meta">
                <span class="time">${new Date(order.timestamp).toLocaleTimeString()}</span>
                <span class="badge badge-${(order.status || 'UNKNOWN').toLowerCase()}">${order.status || 'UNKNOWN'}</span>
                ${(order.signal || order).position ? `<span class="badge badge-info">${(order.signal || order).position}</span>` : ''}
            </div>
            <div class="content">
                ${(order.signal || order).symbol || order.symbol || '—'} ·
                ${order.action || (order.signal || order).action || ''}
                · Order Qty: ${order.orderQty ?? order.quantity ?? '—'}
                · Position Qty: ${order.positionQty != null ? Math.abs(order.positionQty) : '—'}
                @ ${order.price ?? 'MKT'}
            </div>
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
    let hasAnyPnl = false;
    state.positions.forEach(pos => {
        const ltp = state.prices[pos.symbol];
        const hasLtp = Number.isFinite(ltp) && ltp > 0;
        const pnl = positionPnl(pos, hasLtp ? ltp : null);
        if (pnl != null) {
            totalPnl += pnl;
            hasAnyPnl = true;
        }

        const ltpEl = document.getElementById(`ltp-${pos.symbol}`);
        const pnlEl = document.getElementById(`pnl-${pos.symbol}`);
        if (ltpEl) {
            ltpEl.textContent = hasLtp
                ? ltp.toFixed(2)
                : (Number(pos.avgPrice) > 0 ? Number(pos.avgPrice).toFixed(2) : '—');
        }
        if (pnlEl) {
            if (pnl == null) {
                pnlEl.textContent = '—';
                pnlEl.className = '';
            } else {
                pnlEl.textContent = `₹${pnl.toFixed(2)}`;
                pnlEl.className = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            }
        }
    });

    totalPnlEl.textContent = hasAnyPnl ? `₹${totalPnl.toFixed(2)}` : '—';
    totalPnlEl.className = `value ${hasAnyPnl ? (totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative') : ''}`;
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
