const fs = require('fs');
const path = require('path');

/**
 * Persists OMS state to a single JSON file (atomic replace).
 * Writes are debounced to batch rapid updates; use flushSync on shutdown.
 */
class OmsStateStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.debounceMs = Number(process.env.OMS_PERSIST_DEBOUNCE_MS) || 400;
        this.timer = null;
        /** @type {(() => object) | null} */
        this.getSnapshot = null;k
    }

    ensureDir() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * @returns {object | null}
     */
    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                return null;
            }
            const raw = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(raw);
        } catch (err) {
            console.error('[OmsStateStore] load failed:', err.message);
            return null;
        }
    }

    /**
     * @param {() => object} snapshotGetter
     */
    scheduleSave(snapshotGetter) {
        this.getSnapshot = snapshotGetter;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            try {
                const snap = this.getSnapshot && this.getSnapshot();
                if (snap) {
                    this._write(snap);
                }
            } catch (err) {
                console.error('[OmsStateStore] snapshot error:', err.message);
            }
            this.getSnapshot = null;
        }, this.debounceMs);
    }

    /**
     * @param {(() => object) | undefined} snapshotGetter optional; uses last scheduled getter if omitted
     */
    flushSync(snapshotGetter) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const getter = snapshotGetter || this.getSnapshot;
        this.getSnapshot = null;
        try {
            const snap = getter && getter();
            if (snap) {
                this._write(snap);
            }
        } catch (err) {
            console.error('[OmsStateStore] flushSync error:', err.message);
        }
    }

    _write(snapshot) {
        try {
            this.ensureDir();
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            console.error('[OmsStateStore] save failed:', err.message);
        }
    }
}

module.exports = OmsStateStore;
