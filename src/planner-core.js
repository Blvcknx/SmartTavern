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

/**
 * Parses the planner's reply. Reserved headings: `## Expansion: Name` / `## User: Name`
 * add blocks; `## Skip: Exact block name` (optional one-line reason as its body) skips an
 * existing block whose activation is 'planner' — skipped blocks free their slot of the
 * five-block ceiling; `## Fields: Name, Name` lists the 'relevant' schema fields the
 * reply model should see (`fieldNames` validates them). `skips` / `fields` are present in
 * the result only when the planner used those headings.
 */
export function parseExpansionPlan(text, existing = [], { fieldNames = [] } = {}) {
    const value = cleanAgentText(text);
    const additions = [];
    const issues = [];
    const skips = [];
    let fields = null;
    const names = new Set(existing.map(step => String(step.name).trim().toLowerCase()));
    const headings = [...value.matchAll(/^[ \t]{0,3}#{2}[ \t]+(Expansion|User|Skip|Fields)[ \t]*:[ \t]*([^\n]*)$/gim)];
    if (!headings.length && value.toUpperCase() !== 'NO ADDITIONS') issues.push('No Expansion / User / Skip / Fields headings or NO ADDITIONS returned.');
    const bodyOf = index => value.slice(headings[index].index + headings[index][0].length, headings[index + 1]?.index ?? value.length).trim();
    const known = new Map(fieldNames.map(name => [String(name).trim().toLowerCase(), String(name)]));
    headings.forEach((heading, index) => {
        const kind = heading[1].toLowerCase();
        if (kind === 'skip') {
            const name = heading[2].trim().replace(/\s+#+\s*$/, '').trim();
            const block = existing.find(step => String(step.name).trim().toLowerCase() === name.toLowerCase());
            if (!block || block.activation !== 'planner') {
                issues.push(`Ignored skip of a block that does not exist or cannot be skipped: ${name || '(unnamed)'}`);
            } else if (!skips.some(skip => skip.name === block.name)) {
                const reason = bodyOf(index).split('\n').map(line => line.trim()).find(Boolean) ?? '';
                skips.push({ name: block.name, reason: reason.slice(0, 200) });
            }
        } else if (kind === 'fields') {
            const body = bodyOf(index);
            const list = (heading[2].trim() || body.split('\n')[0] || '').split(/[,\n]/).map(item => item.trim()).filter(item => item && !/^(none|n\/a|-)$/i.test(item));
            fields ??= [];
            for (const item of list) {
                const canonical = known.get(item.toLowerCase());
                if (canonical) {
                    if (!fields.includes(canonical)) fields.push(canonical);
                } else issues.push(`Ignored unknown field: ${item}`);
            }
        }
    });
    for (let index = 0; index < headings.length && existing.length - skips.length + additions.length < EXPANSION_LIMIT; index++) {
        const heading = headings[index];
        if (!/^(expansion|user)$/i.test(heading[1])) continue;
        const name = heading[2].trim().replace(/\s+#+\s*$/, '').trim();
        const prompt = bodyOf(index);
        const dependencies = [...prompt.matchAll(/\{\{\s*step\s*:\s*([^{}]+?)\s*\}\}/gi)].map(match => match[1].trim().toLowerCase());
        if (!name || !prompt || names.has(name.toLowerCase()) || dependencies.some(dependency => !names.has(dependency))) {
            issues.push(`Ignored invalid, duplicate, or forward-dependent block: ${name || '(unnamed)'}`);
            continue;
        }
        additions.push({ name, prompt, ...(heading[1].toLowerCase() === 'user' ? { kind: 'user' } : {}) });
        names.add(name.toLowerCase());
    }
    return { additions, issues, ...(skips.length ? { skips } : {}), ...(fields ? { fields } : {}) };
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
