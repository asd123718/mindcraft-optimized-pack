import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpectatorPlayer } from '../agent/spectator.js';

export const defaultSpectatorPreferencesFile = fileURLToPath(new URL('../../server_data/spectator.json', import.meta.url));

export function loadSpectatorPreferences(preferencesFile = defaultSpectatorPreferencesFile) {
    try {
        const data = JSON.parse(readFileSync(preferencesFile, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn('Cannot load spectator preferences:', error.message);
        return {};
    }
}

export function saveSpectatorPreference(preferences, agentName, value, preferencesFile = defaultSpectatorPreferencesFile) {
    if (typeof value?.auto !== 'boolean') throw new Error('自动切换设置无效。');
    const player = typeof value.player === 'string' ? value.player.trim() : '';
    if (player || value.auto) validateSpectatorPlayer(player, agentName);
    const next = { ...preferences, [agentName]: { player, auto: value.auto } };
    // One automatic camera target per player, so reconnecting agents do not fight.
    if (value.auto) {
        for (const [name, config] of Object.entries(next)) {
            if (name !== agentName && config.player?.toLowerCase() === player.toLowerCase()) {
                next[name] = { ...config, auto: false };
            }
        }
    }
    mkdirSync(path.dirname(preferencesFile), { recursive: true });
    writeFileSync(`${preferencesFile}.tmp`, JSON.stringify(next, null, 2), 'utf8');
    renameSync(`${preferencesFile}.tmp`, preferencesFile);
    return next;
}
