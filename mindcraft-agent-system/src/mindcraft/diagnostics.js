export function safeDiagnostic(value) {
    const seen = new WeakSet();
    const text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => {
        if (/(?:api.?key|authorization|password|secret|token)$/i.test(key)) return '[REDACTED]';
        if (item && typeof item === 'object') { if (seen.has(item)) return '[Circular]'; seen.add(item); }
        return item;
    });
    return String(text ?? '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 8000);
}

export class DiagnosticLog {
    constructor(limit = 500) { this.limit = limit; this.sequence = 0; this.entries = new Map(); }
    add(agent, event) {
        const entry = { id: ++this.sequence, time: new Date().toISOString(), agent,
            level: ['error','warn'].includes(event?.level) ? event.level : 'info',
            type: String(event?.type || 'log').slice(0, 80), detail: safeDiagnostic(event?.detail ?? event?.text ?? event) };
        const rows = this.entries.get(agent) || [];
        rows.push(entry);
        if (rows.length > this.limit) rows.splice(0, rows.length - this.limit);
        this.entries.set(agent, rows);
        return entry;
    }
    read(agent, after = 0) {
        const rows = this.entries.get(agent) || [];
        return { entries: rows.filter(row => row.id > after), cursor: rows.at(-1)?.id || 0,
            truncated: after > 0 && rows.length > 0 && after < rows[0].id - 1 };
    }
}
