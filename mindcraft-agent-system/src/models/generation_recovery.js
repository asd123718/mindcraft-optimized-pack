// A failed generation has not executed its proposed tools. Retry only that
// generation, keeping the completed tool results in the current session.
export function isRecoverableGenerationError(error) {
    if (/budget_|quota|invalid.*key|authentication|permission/i.test(String(error?.code || '') + ' ' + String(error?.message || ''))) return false;
    return ['reasoning_loop', 'reasoning_limit', 'generation_stalled', 'incomplete_generation'].includes(error?.code)
        || [408, 429, 500, 502, 503, 504].includes(error?.status)
        || /incomplete|truncated|empty completion|completion marker|timed?\s*out|timeout|connection|fetch failed|try\s*again\s*shortly|ECONN|ETIMEDOUT/i.test(String(error?.message || error));
}

export function createRepetitionGuard() {
    let tail = '', unchecked = 0;
    return text => {
        tail = (tail + text).slice(-6000);
        unchecked += text.length;
        if (tail.length < 128 || unchecked < 128) return;
        unchecked = 0;
        // Four adjacent repetitions of a substantial phrase, including when
        // sentence or token boundaries cross streamed chunks.
        const normalized = tail.toLowerCase().replace(/\s+/g, ' ');
        for (let size=24;size<=Math.min(500,Math.floor(normalized.length/4));size++) {
            const phrase=normalized.slice(-size);
            if(normalized.slice(-size*2,-size)!==phrase || normalized.slice(-size*3,-size*2)!==phrase || normalized.slice(-size*4,-size*3)!==phrase) continue;
            const error=new Error('Model reasoning repeated without progress');
            error.code='reasoning_loop';throw error;
        }
    };
}
