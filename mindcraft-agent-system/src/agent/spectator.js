import { setTimeout as delay } from 'node:timers/promises';

export function validateSpectatorPlayer(player, agentName) {
    if (typeof player !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(player)) {
        throw new Error('请输入有效的 Minecraft 玩家名（1–16 位字母、数字或下划线）。');
    }
    if (player.toLowerCase() === agentName.toLowerCase()) {
        throw new Error('旁观玩家不能是 agent 自己。');
    }
    return player;
}

// Framework control only: never routed through conversation or model commands.
export async function switchSpectatorView(bot, player) {
    validateSpectatorPlayer(player, bot.username);
    validateSpectatorPlayer(bot.username, player);
    const ensureOnline = () => {
        if (!bot.entity || bot._client?.state !== 'play') throw new Error('Agent 尚未进入世界。');
        if (!bot.players[player]) throw new Error(`玩家 ${player} 不在线；请先进入同一个世界。`);
    };
    ensureOnline();
    bot.chat(`/gamemode spectator ${player}`);
    // Give the server time to apply spectator mode before attaching the camera.
    await delay(400);
    ensureOnline();
    bot.chat(`/spectate ${bot.username} ${player}`);
    return { success: true, message: '已依次发送旁观模式和视角切换指令；若游戏内未生效，请检查 agent 的 OP 权限及游戏命令反馈。' };
}
