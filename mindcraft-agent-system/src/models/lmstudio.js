import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';
import { createResponseStream } from './response_stream.js';
import { createRepetitionGuard } from './generation_recovery.js';

const MAX_OUTPUT_TOKENS = 131072;
const DEFAULT_TIMEOUT_MS = 45000;

function outputLimit(params, fallback) {
    const requested = Number(params.max_completion_tokens ?? params.max_tokens);
    return Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), MAX_OUTPUT_TOKENS) : fallback;
}

function requestTimeoutMs(limit) {
    return limit <= 4096 ? DEFAULT_TIMEOUT_MS : Math.ceil(limit * 3600000 / MAX_OUTPUT_TOKENS);
}

export class LMStudio {
    static prefix = 'lmstudio';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.pendingRequests = new Set();
        this.openai = new OpenAIApi({
            baseURL: url || 'http://localhost:1234/v1',
            apiKey: 'lm-studio', // LM Studio ignores this but the client requires a non-empty value
            timeout: DEFAULT_TIMEOUT_MS,
            maxRetries: 0,
        });
    }

    cancelPendingRequests() {
        for (const controller of this.pendingRequests) controller.abort();
    }

    async sendRequest(turns, systemMessage, stop_seq='***', options={}, contextRetries=0) {
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        let model = this.model_name || 'andy-4.1';
        let res;
        const controller = new AbortController();
        this.pendingRequests.add(controller);
        const params = { ...this.params };
        const limit = outputLimit(params, options.reasoning ? 2048 : 768);
        const timeout = options.referenceDefaults ? 600000 : requestTimeoutMs(limit);
        const deadline = setTimeout(() => controller.abort(new Error('Model request timed out')), timeout);

        try {
            console.log('Awaiting LM Studio response from model', model);
            delete params.max_completion_tokens;
            delete params.n_predict;
            if (!options.referenceDefaults && /^andy(?:-|$)/i.test(model)) {
                params.chat_template_kwargs = { enable_thinking: false, ...params.chat_template_kwargs };
                if (options.reasoning !== undefined) params.chat_template_kwargs.enable_thinking = options.reasoning;
                if (params.chat_template_kwargs.enable_thinking) params.reasoning_budget = Math.min(768, Math.floor(limit / 2));
            }
            const pack = {
                model,
                messages,
                stop: stop_seq,
                ...params,
                ...(!options.referenceDefaults && {max_tokens: limit}),
                stream: true,
            };
            const completion = await this.openai.chat.completions.create(pack, { signal: controller.signal, timeout });
            if (controller.signal.aborted) return '';
            const response = createResponseStream(delta => {
                if (!controller.signal.aborted) options.onDelta?.(delta);
            });
            let finishReason;
            if (completion[Symbol.asyncIterator]) {
                for await (const chunk of completion) {
                    if (controller.signal.aborted) return '';
                    const choice = chunk.choices?.[0];
                    if (!choice) continue;
                    response.push(choice.delta || {});
                    if (choice.finish_reason) finishReason = choice.finish_reason;
                }
            } else {
                // Some compatible endpoints return a normal completion despite stream=true.
                response.push(completion.choices[0].message);
                finishReason = completion.choices[0].finish_reason;
            }
            if (controller.signal.aborted) return '';
            if (!finishReason) throw new Error('Model stream ended without a completion marker');
            res = response.finish();
            if (finishReason === 'length') {
                if (options.referenceDefaults) throw Object.assign(new Error('Context length exceeded'), {code: 'context_length_exceeded'});
                console.warn(`Model response reached the ${limit}-token output limit; not executing truncated commands.`);
                return '模型回复达到输出上限，已停止本次生成。请简化指令后重试。';
            }
            console.log('Received.');
        } catch (err) {
            if (controller.signal.aborted) {
                if (controller.signal.reason?.message === 'Model request timed out') {
                    console.warn(`Model request timed out after ${timeout / 1000} seconds.`);
                    return '模型请求超时，已取消本次生成。请重试。';
                }
                return '';
            }
            if (err.code === 'context_length_exceeded' && turns.length > 1 && (options.referenceDefaults || contextRetries < 1)) {
                console.log('Context length exceeded, trying again with shorter context.');
                options.onReset?.();
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, options, contextRetries + 1);
            } else {
                console.warn('Local model request failed:', err.message);
                if (options.referenceDefaults) return 'My brain disconnected, try again.';
                res = err.name === 'APIConnectionTimeoutError'
                    ? '模型请求超时，已停止等待。请重试。'
                    : '本地模型请求失败，请检查模型服务后重试。';
            }
        } finally {
            clearTimeout(deadline);
            this.pendingRequests.delete(controller);
        }
        return res;
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async sendNativeStream(turns, systemMessage, tools, responseFormat, {signal,onDelta,skipThinking=false}={}) {
        const controller = new AbortController();this.pendingRequests.add(controller);
        const params = {...this.params};
        const limit = outputLimit(params, 2048);
        const timeout = requestTimeoutMs(limit);
        delete params.max_completion_tokens;
        delete params.n_predict;
        const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
        const calls=new Map();let reason;const guard=createRepetitionGuard();
        let idleTimer, reasoningTimer;
        const abortWith = (code, message) => controller.abort(Object.assign(new Error(message), {code}));
        const watchStream = ms => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => abortWith('generation_stalled', 'Model stream stopped delivering chunks'), ms);
        };
        const response = createResponseStream(delta => {
            if (delta.kind === 'reasoning') {
                reasoningTimer ??= setTimeout(() => abortWith('reasoning_limit', 'Model reasoning exceeded 20 seconds'), 20000);
                guard(delta.text);
            } else {
                clearTimeout(reasoningTimer);
                reasoningTimer = undefined;
            }
            onDelta?.(delta);
        });
        watchStream(60000);
        try {
            const stream=await this.openai.chat.completions.create({...params,model:this.model_name,
                // Qwen/Andy accepts a system role only at the beginning. Older
                // framework observations in history are data, not new instructions.
                messages:[{role:'system',content:systemMessage},...turns.map(turn => turn.role === 'system'
                    ? {...turn,role:'user',content:`[Framework observation]\n${turn.content}`}
                    : turn)],tools,stream:true,max_tokens:limit,
                reasoning_budget:768,chat_template_kwargs:{...params.chat_template_kwargs,enable_thinking:!skipThinking},
                ...(responseFormat?{response_format:responseFormat}:{})},{signal:combined, timeout});
            for await(const chunk of stream) {
                combined.throwIfAborted();watchStream(15000);
                const choice=chunk.choices?.[0];if(!choice)continue;
                response.push(choice.delta||{});
                if (choice.delta?.tool_calls?.length) {
                    clearTimeout(reasoningTimer);
                    reasoningTimer = undefined;
                }
                for(const part of choice.delta?.tool_calls||[]) {
                    const call=calls.get(part.index)||{id:'',name:'',arguments:''};if(part.id)call.id=part.id;
                    call.name+=part.function?.name||'';call.arguments+=part.function?.arguments||'';calls.set(part.index,call);
                }
                if(choice.finish_reason)reason=choice.finish_reason;
            }
            combined.throwIfAborted();if(!reason||reason==='length')throw new Error('Tool response incomplete; no tools executed');
            const text=response.finish();return [text.includes('</think>')?text.split('</think>').pop():text,[...calls.values()]];
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw error;
        } finally {
            clearTimeout(idleTimer);
            clearTimeout(reasoningTimer);
            controller.abort();
            this.pendingRequests.delete(controller);
        }
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'text-embedding-nomic-embed-text-v1.5',
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}
