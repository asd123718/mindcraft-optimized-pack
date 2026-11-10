import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import settings from '../../settings.js';
import { applySessionPolicy, sessionOnlySettings } from '../utils/session_policy.js';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const builtInAndyModels = new Set(['andy-4.2-q8-reference', 'andy-4.2-micro-q4', 'andy-4.2-air-q4']);
const builtInAndyChoices = new Set(['Auto', 'Micro', 'Air', 'Q8']);

export function resolveBuiltInAndyProfile(profile) {
    const activeModel = process.env.MINDCRAFT_BUILTIN_ANDY42;
    if (builtInAndyModels.has(activeModel) && profile?.reference_andy42 === true &&
        profile.model?.api === 'lmstudio' && profile.model.url === 'http://127.0.0.1:1235/v1' &&
        builtInAndyModels.has(profile.model.model)) {
        return { ...profile, model: { ...profile.model, model: activeModel } };
    }
    return profile;
}

function readJson(file, fallback) {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), 'utf8');
    renameSync(`${file}.tmp`, file);
}

export function loadConsoleDefaults(root = projectRoot) {
    const overrides = readJson(path.join(root, 'server_data/console-settings.json'), {});
    if (!object(overrides)) throw new Error('控制台默认设置格式无效。');
    for (const key of Object.keys(settings)) {
        if (key !== 'profile' && !Object.hasOwn(sessionOnlySettings, key) && Object.hasOwn(overrides, key)) settings[key] = overrides[key];
    }
    applySessionPolicy(settings);
}

export function createConsoleConfig(root = projectRoot) {
    applySessionPolicy(settings);
    const settingsFile = path.join(root, 'server_data/console-settings.json');
    const preferencesFile = path.join(root, 'server_data/console-preferences.json');
    const andyModelFile = path.join(root, 'server_data/andy-model-choice.json');
    const keysFile = path.join(root, 'keys.json');
    const spec = JSON.parse(readFileSync(new URL('./public/settings_spec.json', import.meta.url), 'utf8'));
    const globals = new Set(['mindserver_port', 'auto_open_ui', 'profiles']);
    for (const [key, value] of Object.entries(settings)) {
        if (key === 'profile') continue;
        spec[key] ||= { type: Array.isArray(value) ? 'array' : value === null ? 'object' : typeof value, default: value };
        if (value === null) spec[key].nullable = true;
        if (globals.has(key)) spec[key].scope = 'global';
    }
    for (const [key, value] of Object.entries(sessionOnlySettings)) {
        spec[key] = { ...spec[key], default: value, readOnly: true, nullable: value === null, description: '已按用户要求禁用：指令仅保留在当前连接，不保存、不自动恢复或启动任务。' };
    }
    const cleanSettings = () => Object.fromEntries(Object.entries(settings).filter(([key]) => key in spec && key !== 'profile' && key !== 'api_keys'));
    const validateSettings = (values, allowProfile = false) => {
        if (!object(values)) throw new Error('设置必须是对象。');
        const clean = {};
        for (const [key, value] of Object.entries(values)) {
            if (Object.hasOwn(sessionOnlySettings, key)) {
                if (value !== sessionOnlySettings[key]) throw new Error('已禁止持久化或自动恢复指令，请在连接后主动发送指令。');
                clean[key] = value;
                continue;
            }
            const rule = spec[key];
            if (!rule || key === 'api_keys' || key === 'api_key_names' || (key === 'profile' && !allowProfile)) continue;
            if (value === null && rule.nullable) { clean[key] = null; continue; }
            const type = Array.isArray(value) ? 'array' : typeof value;
            if (type !== rule.type || value === null || (type === 'number' && !Number.isFinite(value))) throw new Error(`设置 ${key} 类型无效。`);
            if (rule.options && !rule.options.includes(value)) throw new Error(`设置 ${key} 选项无效。`);
            if (key === 'port' && (!Number.isInteger(value) || value < -1 || value > 65535)) throw new Error('服务器端口无效。');
            if (key === 'mindserver_port' && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error('控制台端口无效。');
            if (['profiles', 'only_chat_with', 'blocked_actions'].includes(key) && value.some(item => typeof item !== 'string')) throw new Error(`设置 ${key} 必须为字符串数组。`);
            clean[key] = value;
        }
        return clean;
    };
    const validateProfile = profile => {
        if (!object(profile) || !/^[A-Za-z0-9_]{1,16}$/.test(profile.name)) throw new Error('智能体名称必须为 1–16 位字母、数字或下划线。');
        return profile;
    };
    const profilePaths = () => {
        const paths = new Set(Array.isArray(settings.profiles) ? settings.profiles : []);
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.json') && !['keys.json', 'package.json', 'package-lock.json'].includes(entry.name)) paths.add(`./${entry.name}`);
        }
        const scan = directory => {
            if (!existsSync(directory)) return;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) scan(full);
                else if (entry.isFile() && entry.name.endsWith('.json')) paths.add(`./${path.relative(root, full).split(path.sep).join('/')}`);
            }
        };
        scan(path.join(root, 'profiles'));
        return paths;
    };
    const resolveProfile = requested => {
        if (typeof requested !== 'string') throw new Error('角色路径无效。');
        const resolved = path.resolve(root, requested);
        const relative = path.relative(realpathSync(root), realpathSync(resolved));
        if (relative.startsWith('..') || path.isAbsolute(relative) || ![...profilePaths()].some(item => path.resolve(root, item) === resolved)) throw new Error('不允许读取该角色路径。');
        return resolved;
    };
    const keyNames = () => {
        const keys = readJson(keysFile, {});
        return [...new Set([...Object.keys(keys), ...Object.keys(process.env)])]
            .filter(name => /^(?:[A-Z][A-Z0-9_]*_API_KEY|OPENAI_ORG_ID)$/.test(name) && (keys[name] || process.env[name]));
    };
    return {
        spec, cleanSettings, validateSettings, validateProfile, keyNames,
        saveSettings(values) {
            const clean = validateSettings(values);
            const restart_required = [...globals].filter(key => key in clean && JSON.stringify(clean[key]) !== JSON.stringify(settings[key]));
            const persisted = { ...readJson(settingsFile, {}), ...clean };
            for (const key of Object.keys(sessionOnlySettings)) delete persisted[key];
            writeJson(settingsFile, persisted);
            Object.assign(settings, clean);
            return { success: true, settings: cleanSettings(), restart_required };
        },
        preferences() {
            return readJson(preferencesFile, { appearance: { theme: 'dark', motion: true, density: 'comfortable' }, model_catalog: {} });
        },
        savePreferences(value) {
            if (!object(value) || !object(value.appearance) || !object(value.model_catalog)) throw new Error('界面设置格式无效。');
            writeJson(preferencesFile, value);
            return value;
        },
        listProfiles() {
            return [...profilePaths()].flatMap(file => {
                try {
                    const profile = resolveBuiltInAndyProfile(validateProfile(readJson(resolveProfile(file), null)));
                    return [{ path: file, name: profile.name, model: typeof profile.model === 'string' ? profile.model : profile.model?.model || '' }];
                } catch { return []; }
            });
        },
        loadProfile(file) { return resolveBuiltInAndyProfile(validateProfile(readJson(resolveProfile(file), null))); },
        builtInAndyProfile() {
            if (!builtInAndyModels.has(process.env.MINDCRAFT_BUILTIN_ANDY42)) return null;
            return resolveBuiltInAndyProfile(readJson(path.join(root, 'andy-reference.json'), null));
        },
        builtInAndyModelChoice() {
            const active = process.env.MINDCRAFT_BUILTIN_ANDY42;
            if (!builtInAndyModels.has(active)) return null;
            let model;
            try {
                model = readJson(andyModelFile, null)?.model;
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
            }
            return { active, model: builtInAndyChoices.has(model) ? model : 'Auto' };
        },
        saveBuiltInAndyModelChoice(model) {
            if (!builtInAndyModels.has(process.env.MINDCRAFT_BUILTIN_ANDY42)) throw new Error('内置 Andy 4.2 服务未运行。');
            if (!builtInAndyChoices.has(model)) throw new Error('内置模型选项无效。');
            writeJson(andyModelFile, { model });
        },
        saveProfile(profile) {
            validateProfile(profile);
            const file = `./profiles/user/${profile.name}.json`;
            writeJson(path.join(root, file), profile);
            return file;
        },
        saveKeys(values) {
            if (!object(values)) throw new Error('密钥设置格式无效。');
            const keys = readJson(keysFile, {});
            for (const [name, value] of Object.entries(values)) {
                if (!/^(?:[A-Z][A-Z0-9_]*_API_KEY|OPENAI_ORG_ID)$/.test(name) || typeof value !== 'string') throw new Error('密钥名称或值无效。');
                if (value.trim()) keys[name] = value.trim();
            }
            if (Object.values(values).some(value => value.trim())) writeJson(keysFile, keys);
            return keyNames();
        },
    };
}
