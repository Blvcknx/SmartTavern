// Only require a reply payload or an explicit no-change audit.
export function refinementIssues(rawOutput) {
    const raw = String(rawOutput ?? '').trim();
    const wrapped = raw.match(/<(revised_reply|final_reply)>([\s\S]*?)<\/\1>/i);
    if (!wrapped && /<audit>\s*PASS\s*<\/audit>/i.test(raw)) return [];
    const payload = wrapped ? wrapped[2] : raw.replace(/<audit>[\s\S]*?<\/audit>/gi, '');
    return payload.trim() ? [] : ['The reply is empty.'];
}
