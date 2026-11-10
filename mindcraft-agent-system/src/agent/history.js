import settings from './settings.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.turns = [];
        this.toolProgress = new Map();

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    recordToolProgress(call, result) {
        if (result.status === 'cancelled') return;
        const compact = text => {
            const line = text.replace(/\s+/g, ' ').trim();
            return line.length > 420 ? `${line.slice(0, 250)} … ${line.slice(-160)}` : line;
        };
        const entry = {
            tool: call.name,
            args: JSON.stringify(call.arguments ?? {}).slice(0, 240),
            status: result.status,
            result: compact(result.text),
        };
        const key = JSON.stringify(entry);
        const previous = this.toolProgress.get(key);
        this.toolProgress.delete(key);
        this.toolProgress.set(key, {...entry, count: (previous?.count ?? 0) + 1});
        if (this.toolProgress.size > 24) this.toolProgress.delete(this.toolProgress.keys().next().value);
    }

    getToolProgress() {
        return Array.from(this.toolProgress.values());
    }

    async summarizeMemories(turns) {
        console.log('Summarizing current session context in memory...');
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    // Compatibility hooks intentionally do no disk I/O. Session context stays
    // in RAM and is discarded when the agent leaves or reconnects.
    appendFullHistory() {}

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
        }
    }

    save() {}

    load() {
        return null;
    }

    clear() {
        this.turns = [];
        this.memory = '';
        this.toolProgress.clear();
    }
}
