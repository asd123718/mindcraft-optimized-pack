// Split legacy inline think tags even when a tag crosses SSE chunk boundaries.
export function createResponseStream(onDelta = () => {}) {
    let buffer = '';
    let thinking = false;
    let reasoning = '';
    let content = '';
    const emit = (kind, text) => {
        if (!text) return;
        if (kind === 'reasoning') reasoning += text;
        else content += text;
        onDelta({ kind, text });
    };
    const drain = (final = false) => {
        while (buffer) {
            const tag = thinking ? '</think>' : '<think>';
            const index = buffer.toLowerCase().indexOf(tag);
            if (index >= 0) {
                emit(thinking ? 'reasoning' : 'content', buffer.slice(0, index));
                buffer = buffer.slice(index + tag.length);
                thinking = !thinking;
                continue;
            }
            let held = 0;
            if (!final) {
                for (let n = 1; n < tag.length && n <= buffer.length; n++) {
                    if (tag.startsWith(buffer.slice(-n).toLowerCase())) held = n;
                }
            }
            emit(thinking ? 'reasoning' : 'content', buffer.slice(0, buffer.length - held));
            buffer = held ? buffer.slice(-held) : '';
            break;
        }
    };
    return {
        push(delta) {
            emit('reasoning', delta.reasoning_content || delta.reasoning || '');
            if (delta.content) { buffer += delta.content; drain(); }
        },
        finish() {
            drain(true);
            return reasoning ? `<think>\n${reasoning}\n</think>\n${content}` : content;
        },
    };
}
