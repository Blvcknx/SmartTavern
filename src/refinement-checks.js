import { parseDraftEdits, editIssues, stripThinkBlocks } from './refinement-edits.js';

/** Infer only observable work from cumulative provider output; never from a timer. */
export function refinementPhase({ content = '', reasoning = '' } = {}) {
    const raw = String(content);
    const visible = stripThinkBlocks(raw).replace(/^\s*(?:```|~~~)[^\n]*\n/, '').trim();
    // An edit can follow an audit in the same response. Ignore quoted edit tags
    // inside the audit itself when deciding whether rewriting has started.
    const afterAudit = visible.replace(/<audit\b[^>]*>[\s\S]*?(?:<\/audit\s*>|$)/gi, '').trim();
    if (/<(?:replace|edit|delete|insert|revised_reply|final_reply|p)\b/i.test(afterAudit)) return 'Rewriting reply';
    if (afterAudit && !/^<[^>]*$/.test(afterAudit)) return 'Rewriting reply';
    if (/<audit\b/i.test(visible)) return 'Audit';
    if (String(reasoning).trim() || /<think\b/i.test(raw)) return 'Reasoning';
    return 'Waiting for the provider';
}

// Surgical refinement helpers re-exported for one-stop importing in the pipeline.
export {
    splitParagraphs, numberedDraft, paragraphBlocks,
    stripThinkBlocks, stripEditorNoise, parseDraftEdits,
    editIssues, applyDraftEdits,
} from './refinement-edits.js';

// Only require a reply payload or an explicit no-change audit. `blocks` (the
// numbered-draft paragraph list) switches validation to the surgical patch
// contract; anything else keeps the classic whole-reply checks.
export function refinementIssues(rawOutput, blocks = null) {
    const raw = String(rawOutput ?? '').trim();
    const wrapped = raw.match(/<(revised_reply|final_reply)>([\s\S]*?)<\/\1>/i);
    if (!wrapped && /<audit>\s*PASS\s*<\/audit>/i.test(raw)) return [];
    if (Array.isArray(blocks)) return surgicalIssues(raw, blocks);
    const payload = wrapped ? wrapped[2] : raw.replace(/<audit>[\s\S]*?<\/audit>/gi, '');
    return payload.trim() ? [] : ['The reply is empty.'];
}

/** Issue list for a surgical pass output parsed against the numbered draft. */
export function surgicalIssues(rawOutput, blocks) {
    const raw = String(rawOutput ?? '').trim();
    if (!raw) return ['The reply is empty.'];
    const patch = parseDraftEdits(raw);
    // Bare prose (no ops, no wrapper, no PASS): a clean skip like full mode —
    // the pipeline records it as "no revised reply returned".
    if (!patch) return [];
    if (patch.kind === 'full' && !patch.text.trim()) return ['The reply is empty.'];
    return editIssues(patch, blocks);
}

/** True when the output wraps an actual revised reply in <revised_reply>/<final_reply> tags. */
export function hasRefinedPayload(rawOutput, blocks = null) {
    const raw = String(rawOutput ?? '').trim();
    if (/<(revised_reply|final_reply)>[\s\S]*?<\/\1>/i.test(raw)) return true;
    return Array.isArray(blocks) && parseDraftEdits(raw)?.kind === 'ops';
}
