import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync } from 'fs';
import { defaultSpectatorPreferencesFile, loadSpectatorPreferences, saveSpectatorPreference } from './spectator_preferences.js';
import { validateSpectatorPlayer } from '../agent/spectator.js';
import { createConsoleConfig } from './console_config.js';
import { execFile } from 'node:child_process';
import { DiagnosticLog } from './diagnostics.js';
import {
    isAuthorizedControlRequest,
    resolveControlToken,
    resolveMindServerBindHost,
} from './security.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTROL_ROOM = 'mindcraft:control';
const AGENT_ROOM = 'mindcraft:agents';
const CONTROL_COOKIE = 'mindcraft_control';

let io;
let server;
const agent_connections = {};
const agent_listeners = new Set();
let spectatorPreferences = {};
let spectatorPreferencesFile = defaultSpectatorPreferencesFile;

function requestSpectatorView(agentName, player) {
    const agent = agent_connections[agentName];
    try {
        validateSpectatorPlayer(player, agentName);
        if (!agent?.in_game || !agent.world_ready || !agent.socket) throw new Error('Agent 尚未准备就绪，请等待进入世界。');
        if (agent.spectator_busy) throw new Error('正在切换视角，请稍候。');
    } catch (error) {
        return Promise.resolve({ success: false, error: error.message });
    }
    agent.spectator_busy = true;
    return new Promise(resolve => {
        agent.socket.timeout(5000).emit('spectate-player', player, (error, result) => {
            agent.spectator_busy = false;
            resolve(error ? { success: false, error: '视角指令请求超时或 agent 已断开。' } : result);
        });
    });
}

async function autoSpectate(agentName) {
    const config = spectatorPreferences[agentName];
    if (!config?.auto || agent_connections[agentName]?.spectator_busy) return;
    const result = await requestSpectatorView(agentName, config.player);
    io.to(CONTROL_ROOM).emit('spectator-result', agentName, result);
}

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port, process_token) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.world_ready = false;
        this.chinese_output = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        this.process_token = process_token;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

function parseCookies(header) {
    const cookies = {};
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!key) continue;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch {
            cookies[key] = value;
        }
    }
    return cookies;
}

function providedControlToken(socket) {
    return socket.handshake.auth?.controlToken
        ?? parseCookies(socket.handshake.headers?.cookie)[CONTROL_COOKIE]
        ?? null;
}

export function sanitizeDisplayText(value) {
    return String(value ?? '').replaceAll('<', '＜');
}

export function registerAgent(settings, viewer_port, process_token) {
    const agentConnection = new AgentConnection(settings, viewer_port, process_token);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agent_connections[agentName].world_ready = false;
        agentsStatusUpdate();
    }
}

function isAgentSocketAuthorized(socket, agentName) {
    const connection = agent_connections[agentName];
    if (!connection?.process_token) return false;
    return isAuthorizedControlRequest(socket.handshake.auth?.agentToken, connection.process_token);
}

export function createMindServer(host_public = false, port = 8080, options = {}) {
    spectatorPreferencesFile = options.spectatorPreferencesFile ?? defaultSpectatorPreferencesFile;
    spectatorPreferences = loadSpectatorPreferences(spectatorPreferencesFile);
    const consoleConfig = createConsoleConfig(options.configRoot);
    const diagnostics = new DiagnosticLog();
    const record = (name, event) => {
        const entry = diagnostics.add(name, event);
        io.to(CONTROL_ROOM).emit('runtime-log', entry);
    };
    const controlToken = resolveControlToken(host_public);
    const host = resolveMindServerBindHost(host_public);
    const app = express();
    server = http.createServer(app);
    io = new Server(server);
    let shutdownRequested = false;
    const shutdown = () => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        console.log('Shutting down');
        for (const agentName in agent_connections) mindcraft.stopAgent(agentName);
        setTimeout(() => {
            console.log('Exiting MindServer');
            globalThis.process.exit(0);
        }, 2000);
    };

    app.get('/', (req, res, next) => {
        const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
        if (!queryToken) {
            next();
            return;
        }
        if (!controlToken || !isAuthorizedControlRequest(queryToken, controlToken)) {
            res.status(401).send('Invalid MindServer control token.');
            return;
        }
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const attributes = [
            `${CONTROL_COOKIE}=${encodeURIComponent(controlToken)}`,
            'HttpOnly',
            'SameSite=Strict',
            'Path=/',
        ];
        if (secure) attributes.push('Secure');
        res.setHeader('Set-Cookie', attributes.join('; '));
        res.redirect(302, '/');
    });

    app.get('/settings_spec.json', (req, res) => res.json(consoleConfig.spec));
    app.get('/api/diagnostics/:agent', (req, res) => {
        const token = parseCookies(req.headers.cookie)[CONTROL_COOKIE]
            || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (controlToken ? !isAuthorizedControlRequest(token, controlToken) : host_public) {
            res.status(401).json({ error: 'Unauthorized' }); return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(diagnostics.read(req.params.agent, Math.max(0, Number(req.query.after) || 0)));
    });
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.11');

            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex?.startsWith('data:image')) {
                        const base64 = tex.split(',')[1];
                        const img = globalThis.Buffer.from(base64, 'base64');
                        res.setHeader('Content-Type', 'image/png');
                        return res.end(img);
                    }

                    const base = assets.directory;
                    const guessPaths = [
                        path.join(base, 'items', `${itemName}.png`),
                        path.join(base, 'blocks', `${itemName}.png`),
                    ];
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        const controlAuthorized = () => {
            const hasAgentCredential = typeof socket.handshake.auth?.agentToken === 'string';
            const hasControlCredential = typeof providedControlToken(socket) === 'string';
            if (hasAgentCredential && !hasControlCredential) return false;
            if (!controlToken) return !host_public;
            return isAuthorizedControlRequest(providedControlToken(socket), controlToken);
        };

        const rejectControl = (callback) => {
            const error = 'Unauthorized MindServer control request.';
            if (typeof callback === 'function') callback({ success: false, error });
            else socket.emit('control-error', { error });
        };

        const requireControl = (callback) => {
            if (controlAuthorized()) return true;
            rejectControl(callback);
            return false;
        };

        const requireAgent = (agentName, callback) => {
            if (isAgentSocketAuthorized(socket, agentName)) return true;
            const error = `Unauthorized agent process '${agentName}'.`;
            if (typeof callback === 'function') callback({ error });
            else socket.emit('agent-auth-error', { error });
            return false;
        };

        if (controlAuthorized()) {
            socket.join(CONTROL_ROOM);
            agentsStatusUpdate(socket);
        }

        const consoleRequest = (event, handler) => {
            socket.on(event, async (...args) => {
                const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
                if (!requireControl(callback)) return;
                try {
                    const result = await handler(...args);
                    callback?.(result);
                } catch (error) {
                    callback?.({ success: false, error: error.message });
                }
            });
        };
        consoleRequest('get-console-settings', () => ({
            success: true,
            settings: consoleConfig.cleanSettings(),
            builtInAndyProfile: consoleConfig.builtInAndyProfile(),
        }));
        consoleRequest('get-runtime-logs', (name, after = 0) => ({ success: true, ...diagnostics.read(name, Number(after) || 0) }));
        socket.on('runtime-log', (name, event) => {
            if (!requireAgent(name) || agent_connections[name]?.socket !== socket) return;
            record(name, event);
        });
        consoleRequest('set-console-settings', values => consoleConfig.saveSettings(values));
        consoleRequest('get-console-preferences', () => ({ success: true, preferences: consoleConfig.preferences() }));
        consoleRequest('set-console-preferences', values => ({ success: true, preferences: consoleConfig.savePreferences(values) }));
        consoleRequest('list-profiles', () => ({ success: true, profiles: consoleConfig.listProfiles() }));
        consoleRequest('load-profile', file => ({ success: true, profile: consoleConfig.loadProfile(file) }));
        consoleRequest('save-profile', profile => ({ success: true, path: consoleConfig.saveProfile(profile) }));
        consoleRequest('get-builtin-andy-model', () => ({ success: true, choice: consoleConfig.builtInAndyModelChoice() }));
        consoleRequest('set-builtin-andy-model', (agentName, model) => {
            if (!Object.hasOwn(agent_connections, agentName)) throw new Error('Agent 不存在。');
            consoleConfig.saveBuiltInAndyModelChoice(model);
            return { success: true };
        });
        consoleRequest('get-api-key-status', () => ({ success: true, api_key_names: consoleConfig.keyNames() }));
        consoleRequest('set-api-keys', values => ({ success: true, api_key_names: consoleConfig.saveKeys(values) }));
        consoleRequest('get-ollama-models', () => new Promise(resolve => {
            execFile('ollama', ['list'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
                resolve(error ? { success: false, error: '无法检测 Ollama 模型，请检查 Ollama 是否已安装并启动。' }
                    : { success: true, models: stdout.trim().split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/)[0]).filter(Boolean) });
            });
        }));

        socket.on('create-agent', async (settings, callback) => {
            if (!requireControl(callback)) return;
            try {
                consoleConfig.validateProfile(settings?.profile);
                if (settings.api_keys) consoleConfig.saveKeys(settings.api_keys);
                settings = { ...consoleConfig.cleanSettings(), ...consoleConfig.validateSettings(settings, true) };
            } catch (error) {
                callback?.({ success: false, error: error.message });
                return;
            }
            console.log('API create agent...');
            for (const key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    settings[key] = settings_spec[key].default;
                }
            }
            for (const key in settings) {
                if (!(key in settings_spec)) delete settings[key];
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                const returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error, api_key_names: consoleConfig.keyNames() });
                const name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (!controlAuthorized() && !requireAgent(agentName, callback)) return;
            if (agent_connections[agentName]) {
                const settings = { ...agent_connections[agentName].settings };
                delete settings.api_keys;
                callback({ settings: { ...settings, api_key_names: consoleConfig.keyNames() } });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (!requireAgent(agentName)) return;
            agent_connections[agentName].socket = socket;
            socket.emit('chinese-output', agent_connections[agentName].chinese_output);
            curAgentName = agentName;
            socket.join(AGENT_ROOM);
            agentsStatusUpdate();
        });

        socket.on('login-agent', (agentName) => {
            if (!requireAgent(agentName)) return;
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                agent_connections[agentName].world_ready = false;
                curAgentName = agentName;
                socket.join(AGENT_ROOM);
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]?.socket === socket) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].world_ready = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.has(socket)) removeListener(socket);
        });

        socket.on('chat-message', (agentName, json) => {
            if (!curAgentName || !requireAgent(curAgentName)) return;
            const target = agent_connections[agentName];
            if (!target?.socket) {
                console.warn(`Agent ${curAgentName} tried to send a message to unavailable agent ${agentName}`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            target.socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings, callback) => {
            if (!requireControl(callback)) return;
            const agent = agent_connections[agentName];
            try {
                if (!agent) throw new Error('Agent 不存在。');
                consoleConfig.validateProfile(settings?.profile);
                if (settings.profile.name !== agentName) throw new Error('已有智能体不能直接改名，请新建角色。');
                if (settings.api_keys) consoleConfig.saveKeys(settings.api_keys);
                agent.setSettings({ ...agent.settings, ...consoleConfig.validateSettings(settings, true) });
                agent.socket?.emit('restart-agent');
                callback?.({ success: true, api_key_names: consoleConfig.keyNames() });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        socket.on('restart-agent', (agentName) => {
            if (!requireControl()) return;
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName]?.socket?.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            if (!requireControl()) return;
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            if (!requireControl()) return;
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (!requireControl()) return;
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            if (!requireControl()) return;
            console.log('Killing all agents');
            for (const agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', callback => {
            if (!requireControl(callback)) return;
            if (typeof callback === 'function') callback({ success: true });
            shutdown();
        });

        // Task agents may end their run without receiving operator credentials.
        socket.on('finish-task', (agentName) => {
            if (!requireAgent(agentName)) return;
            const agent = agent_connections[agentName];
            if (curAgentName !== agentName || agent.socket !== socket || !agent.settings.task) {
                socket.emit('agent-auth-error', { error: 'Only a connected task agent can finish a task run.' });
                return;
            }
            shutdown();
        });

        socket.on('send-message', (agentName, data) => {
            if (!requireControl()) return;
            const agent = agent_connections[agentName];
            if (!agent?.socket) {
                console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
            }
            try {
                agent.socket.emit('send-message', data);
            } catch (error) {
                console.error('Error: ', error);
            }
        });

        socket.on('switch-agent-view', async (agentName, player, callback) => {
            if (!requireControl(callback)) return;
            const result = await requestSpectatorView(agentName, player);
            if (typeof callback === 'function') callback(result);
        });

        socket.on('set-spectator-settings', (agentName, config, callback) => {
            if (!requireControl(callback)) return;
            try {
                if (!Object.hasOwn(agent_connections, agentName)) throw new Error('Agent 不存在。');
                spectatorPreferences = saveSpectatorPreference(spectatorPreferences, agentName, config, spectatorPreferencesFile);
                if (typeof callback === 'function') callback({ success: true });
                agentsStatusUpdate();
                if (config.auto && agent_connections[agentName].world_ready) void autoSpectate(agentName);
            } catch (error) {
                if (typeof callback === 'function') callback({ success: false, error: error.message });
            }
        });

        socket.on('agent-world-ready', (agentName) => {
            if (!requireAgent(agentName)) return;
            const agent = agent_connections[agentName];
            if (agent.socket !== socket || !agent.in_game || agent.world_ready) return;
            agent.world_ready = true;
            agentsStatusUpdate();
            void autoSpectate(agentName);
        });

        socket.on('spectator-player-joined', (agentName, player) => {
            if (!requireAgent(agentName)) return;
            const agent = agent_connections[agentName];
            const config = spectatorPreferences[agentName];
            if (agent.socket === socket && agent.world_ready && config?.auto && config.player === player) {
                void autoSpectate(agentName);
            }
        });

        socket.on('set-chinese-output', (agentName, enabled, callback) => {
            if (!requireControl(callback)) return;
            if (typeof callback !== 'function') return;
            if (!Object.hasOwn(agent_connections, agentName) || typeof enabled !== 'boolean') {
                callback({ success: false, error: '智能体或中文输出设置无效。' });
                return;
            }
            const agent = agent_connections[agentName];
            agent.chinese_output = enabled;
            agent.socket?.emit('chinese-output', enabled);
            callback({ success: true });
            agentsStatusUpdate();
        });

        socket.on('bot-output', (agentName, message) => {
            if (!requireAgent(agentName)) return;
            io.to(CONTROL_ROOM).emit('bot-output', agentName, sanitizeDisplayText(message));
        });

        socket.on('agent-trace', (agentName, event) => {
            if (!requireAgent(agentName)) return;
            if (!['think-delta','output-delta'].includes(event?.type)) record(agentName, event);
            io.to(CONTROL_ROOM).emit('agent-trace', agentName, event);
        });

        socket.on('listen-to-agents', () => {
            if (!requireControl()) return;
            addListener(socket);
        });
    });

    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!io) return;
    const agents = [];
    for (const agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName,
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
            world_ready: conn.world_ready,
            chinese_output: conn.chinese_output,
            spectator: spectatorPreferences[agentName] || { player: '', auto: false }
        });
    }

    if (socket) {
        socket.emit('agents-status', agents);
        return;
    }
    io.to(CONTROL_ROOM).emit('agents-status', agents);
    io.to(AGENT_ROOM).emit('agents-status', agents);
}

const STATE_POLL_INTERVAL_MS = 1000;
const STATE_REQUEST_TIMEOUT_MS = 2000;
let listenerInterval = null;
let statePollInFlight = false;

function requestAgentState(agentName, agent) {
    return new Promise((resolve, reject) => {
        if (!agent.socket) {
            reject(new Error(`Agent ${agentName} has no connected socket`));
            return;
        }

        agent.socket.timeout(STATE_REQUEST_TIMEOUT_MS).emit('get-full-state', (error, state) => {
            if (error) {
                reject(new Error(`Timed out waiting for ${agentName} state`, { cause: error }));
                return;
            }
            resolve(state);
        });
    });
}

async function pollAgentStates() {
    if (statePollInFlight) return;
    statePollInFlight = true;

    try {
        const states = {};
        const entries = Object.entries(agent_connections)
            .filter(([, agent]) => agent.in_game);

        await Promise.all(entries.map(async ([agentName, agent]) => {
            try {
                states[agentName] = await requestAgentState(agentName, agent);
            } catch (error) {
                states[agentName] = { error: String(error) };
            }
        }));

        for (let listener of agent_listeners) {
            listener.emit('state-update', states);
        }
    } finally {
        statePollInFlight = false;
    }
}

function addListener(listener_socket) {
    if (agent_listeners.has(listener_socket)) return;
    agent_listeners.add(listener_socket);

    if (agent_listeners.size === 1) {
        listenerInterval = setInterval(() => {
            void pollAgentStates();
        }, STATE_POLL_INTERVAL_MS);
    }
}

function removeListener(listener_socket) {
    agent_listeners.delete(listener_socket);
    if (agent_listeners.size === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.size;
