// Deterministic guardrails for surgical edits. These detect suspicious output,
// not semantic truth; comparisons include the initial draft to catch cumulative drift.
function normalized(text) {
    return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function fragments(text) {
    // Character trigrams work for prose with or without word separators.
    const chars = [...normalized(text).replace(/[^\p{L}\p{N}]/gu, '')];
    const counts = new Map();
    for (let i = 0; i < chars.length - 2; i++) {
        const key = chars.slice(i, i + 3).join('');
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

export function refinementIssues(rawOutput, candidate, currentDraft, originalDraft) {
    const raw = String(rawOutput ?? '').trim();
    const issues = [];
    for (const tag of ['revised_reply', 'final_reply', 'audit']) {
        const opens = [...raw.matchAll(new RegExp(`<${tag}>`, 'gi'))].length;
        const closes = [...raw.matchAll(new RegExp(`</${tag}>`, 'gi'))].length;
        if (opens !== closes || opens > 1 || (opens && !new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'i').test(raw))) {
            issues.push(`Malformed or repeated <${tag}> tags.`);
        }
    }
    const wrapped = raw.match(/<(revised_reply|final_reply)>([\s\S]*?)<\/\1>/i);
    const payload = normalized(wrapped ? wrapped[2] : raw.replace(/<audit>[\s\S]*?<\/audit>/gi, ''));
    const auditPass = !wrapped && /<audit>\s*PASS\s*<\/audit>/i.test(raw);
    if (!auditPass && (!/[\p{L}\p{N}]/u.test(payload) || !/[\p{L}\p{N}]/u.test(candidate)
        || /^(?:[\s\[\]().…_*`-]*(?:unchanged|no changes(?: needed)?|same as (?:above|before)|insert (?:revised )?reply here)[\s\[\]().…_*`-]*)$/iu.test(payload))) {
        issues.push('The reply is empty or contains only a placeholder.');
    }
    const value = normalized(candidate);
    const size = [...value].length;
    const candidateFragments = fragments(candidate);
    for (const [label, draft] of [['previous pass', currentDraft], ['original draft', originalDraft]]) {
        const reference = normalized(draft);
        const referenceSize = [...reference].length;
        if (value === reference || referenceSize < 40) continue;
        const ratio = size / referenceSize;
        if (ratio < 0.6) issues.push(`Reply is ${Math.round((1 - ratio) * 100)}% shorter than the ${label} (limit: 40%).`);
        if (ratio > 2) issues.push(`Reply is more than twice the length of the ${label}.`);
        if (referenceSize < 120) continue;
        const source = fragments(draft);
        let common = 0;
        let total = 0;
        for (const [key, count] of source) {
            total += count;
            common += Math.min(count, candidateFragments.get(key) ?? 0);
        }
        const overlap = total ? common / total : 1;
        if (overlap < 0.35) issues.push(`Only ${Math.round(overlap * 100)}% of the ${label}'s text fragments remain (minimum: 35%).`);
    }
    return issues;
}
