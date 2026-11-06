// Pure text contract and history budgeting for the expansion planner.
export const EXPANSION_LIMIT = 5;
export const PLANNER_LOOKBACK = 24;

export function configuredBlocks(steps) {
    return (Array.isArray(steps) ? steps : []).filter(step => step && step.enabled !== false && String(step.prompt ?? '').trim());
}

export function cleanAgentText(text) {
    return String(text ?? '').replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
        .replace(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/, '$1').trim();
}

export function parseExpansionPlan(text, existing = []) {
    const value = cleanAgentText(text);
    const additions = [];
    const issues = [];
    const names = new Set(existing.map(step => String(step.name).trim().toLowerCase()));
    const headings = [...value.matchAll(/^[ \t]{0,3}#{2}[ \t]+(Expansion|User)[ \t]*:[ \t]*([^\n]*)$/gim)];
    if (!headings.length && value.toUpperCase() !== 'NO ADDITIONS') issues.push('No Expansion / User headings or NO ADDITIONS returned.');
    for (let index = 0; index < headings.length && existing.length + additions.length < EXPANSION_LIMIT; index++) {
        const heading = headings[index];
        const name = heading[2].trim().replace(/\s+#+\s*$/, '').trim();
        const prompt = value.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? value.length).trim();
        const dependencies = [...prompt.matchAll(/\{\{\s*step\s*:\s*([^{}]+?)\s*\}\}/gi)].map(match => match[1].trim().toLowerCase());
        if (!name || !prompt || names.has(name.toLowerCase()) || dependencies.some(dependency => !names.has(dependency))) {
            issues.push(`Ignored invalid, duplicate, or forward-dependent block: ${name || '(unnamed)'}`);
            continue;
        }
        additions.push({ name, prompt, ...(heading[1].toLowerCase() === 'user' ? { kind: 'user' } : {}) });
        names.add(name.toLowerCase());
    }
    return { additions, issues };
}

export function recentMessages(chat, userName = 'User') {
    return (chat ?? []).filter(message => message && !message.is_system && !message.is_hidden
        && !message.extra?.isSmartTavern && !message.smarttavern_ephemeral && String(message.mes ?? '').trim())
        .slice(-PLANNER_LOOKBACK).map(message => `${message.is_user ? userName : message.name || 'Narrator'}: ${message.mes}`);
}

// Keep complete newest messages where possible; only cut inside the last remaining one.
export function reduceHistory(history) {
    if (history.length > 1) return history.slice(1);
    if (history[0]?.length > 1) return [history[0].slice(-Math.floor(history[0].length / 2))];
    return [];
}

export async function fitHistory({ history, fixed, budget, count }) {
    let fitted = [...history];
    while (await count(`${fixed}\n\n${fitted.join('\n\n')}`) > budget) {
        if (!fitted.length) throw new Error('Agent instructions and block definitions exceed the context budget.');
        fitted = reduceHistory(fitted);
    }
    return fitted;
}
