// SmartTavern — surgical refinement helpers: paragraph splitting, numbered draft
// rendering and the <edit>/<delete>/<insert> patch parser/validator/applier.
//
// Surgical passes send the draft as numbered paragraphs and receive only the
// paragraphs that changed — a pass that touches 10% of the reply costs 10% of a
// full rewrite's tokens, which is the entire point: drastically faster passes.
// The parser is deliberately forgiving toward small or old models (DeepSeek R1
// and friends): unclosed tags are salvaged to end-of-output, <think> reasoning
// blocks are stripped, and models that ignore the protocol and echo either a
// numbered draft or a full rewrite are repaired into the same op list instead of
// stalling the pipeline. No JSON anywhere — the grammar is plain tags, so
// reasoning models cannot corrupt a JSON payload they never fully emit.

/** Matches a whole <p id="N">…</p> block (close tag optional: salvages to end). */
const P_PARA_RE = /<p\s+id\s*=\s*["']?\s*(\d+)\s*["']?\s*>([\s\S]*?)(?:<\/p\s*>|$)/gi;

/** Strip complete <think>…</think> reasoning blocks and a trailing unclosed one. */
export function stripThinkBlocks(text) {
    let out = String(text ?? '');
    out = out.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
    const open = out.match(/<think[^>]*>/i);
    if (open) {
        if (/\/>\s*$/.test(open[0])) out = out.replace(open[0], '');
        else if (!/<\/think>/i.test(out)) out = out.slice(0, open.index);
    }
    return out;
}

/**
 * Cleanup applied before op parsing: reasoning blocks, one surrounding code fence
 * and closed <audit> blocks go away. The op tags themselves must survive here,
 * so stray-tag removal lives in `stripEditorNoise` instead.
 */
function stripOuterNoise(text) {
    return stripAudits(stripThinkAndFence(text));
}

/** Reasoning blocks and one surrounding code fence. */
function stripThinkAndFence(text) {
    let out = stripThinkBlocks(text).trim();
    const fenced = out.match(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1$/);
    if (fenced) out = fenced[2].trim();
    return out.trim();
}

/** Closed <audit> blocks. The PASS marker is checked before this runs. */
function stripAudits(text) {
    return String(text ?? '').replace(/<audit>[\s\S]*?<\/audit>/gi, '').trim();
}

/**
 * Payload cleanup: outer noise plus stray refinement, op and paragraph wrapper
 * tags — used on edit/insert bodies, full-rewrite payloads and final text, never
 * on the op spans being parsed.
 */
export function stripEditorNoise(text) {
    let out = stripOuterNoise(text);
    out = out.replace(/<\/?(?:revised_reply|final_reply|audit|edit|delete|insert|p)\b[^>]*>/gi, '');
    return out.trim();
}

/**
 * Splits a draft into paragraphs. Blank lines separate paragraphs; fenced code
 * blocks (``` / ~~~) are atomic even when they contain blank lines; a draft with
 * no blank-line separation falls back to single newlines. The separator each
 * paragraph was preceded by is kept so edits can rebuild the original layout.
 *
 * @returns {{paragraphs: string[], separators: string[]}} separators[i] sits
 *          between paragraphs[i] and paragraphs[i+1].
 */
export function splitParagraphs(text) {
    const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!value) return { paragraphs: [], separators: [] };
    const lines = value.split('\n');
    const paragraphs = [];
    const separators = [];
    let buffer = [];
    let gap = '';       // exact separator that preceded the paragraph in `buffer`
    let blanks = 0;
    let inFence = false;
    const flush = () => {
        const paragraph = buffer.join('\n').trim();
        buffer = [];
        if (!paragraph) return;
        // separators[i] is the separator between paragraphs[i] and paragraphs[i+1]
        if (paragraphs.length) separators.push(gap);
        paragraphs.push(paragraph);
    };
    const startGap = () => { gap = '\n'.repeat(1 + Math.min(blanks, 1)); blanks = 0; };
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
            // A fence opening after a blank line starts a new paragraph; a fence
            // line inside (or closing) a block just joins it.
            if (!inFence && blanks && buffer.length) { flush(); startGap(); }
            inFence = !inFence;
            buffer.push(line);
            continue;
        }
        if (!inFence && !line.trim()) { blanks++; continue; }
        if (!inFence && blanks && buffer.length) { flush(); startGap(); }
        buffer.push(line);
    }
    flush();
    if (paragraphs.length > 1) return { paragraphs, separators };
    // No blank-line structure and no fences: fall back to single newlines so a
    // one-block draft still offers per-paragraph surgical targets.
    if (paragraphs.length === 1 && !/^\s*(```|~~~)/m.test(value)) {
        const byLine = value.split('\n').map(l => l.trim()).filter(Boolean);
        if (byLine.length > 1) {
            return { paragraphs: byLine, separators: Array(byLine.length - 1).fill('\n') };
        }
    }
    return { paragraphs, separators };
}

/**
 * The numbered draft shown to surgical passes: every paragraph wrapped as
 * <p id="N">…</p>, ids 1-based in draft order.
 */
export function numberedDraft(text) {
    const { paragraphs } = splitParagraphs(text);
    if (!paragraphs.length) return String(text ?? '');
    return paragraphs.map((paragraph, index) => `<p id="${index + 1}">${paragraph}</p>`).join('\n\n');
}

/** Internal: per-block record carrying the separator that preceded the block. */
function blockRecords(text) {
    const { paragraphs, separators } = splitParagraphs(text);
    return paragraphs.map((paragraph, index) => ({
        text: paragraph,
        sepBefore: index === 0 ? '' : (separators[index - 1] ?? '\n\n'),
    }));
}

/** Public paragraph block list used by the pipeline and the validators. */
export function paragraphBlocks(text) {
    return blockRecords(text);
}

/** Internal: extract op tag spans of one kind; unclosed tags extend to the end. */
function collectSpans(raw, kind) {
    const open = new RegExp(`<${kind}\\b[^>]*>`, 'gi');
    const close = new RegExp(`</${kind}\\s*>`, 'i');
    const spans = [];
    let match;
    while ((match = open.exec(raw))) {
        const rest = raw.slice(match.index + match[0].length);
        const end = rest.match(close);
        spans.push({
            start: match.index,
            rawTag: match[0],
            body: end ? rest.slice(0, end.index) : rest,
            // A self-closing tag (<delete id="N"/>) ends at the opener itself.
            closed: Boolean(end) || /\/\s*>$/.test(match[0]),
        });
    }
    return spans;
}

/** `id`-like attribute value (digits, or the literal `end` for insert anchors). */
function attrValue(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?\\s*(\\d+|end)\\s*["']?`, 'i'));
    return match ? match[1] : null;
}

/** Paragraph anchor: id / paragraph / index attribute, as a 0-based-valid number. */
function anchorValue(tag) {
    const raw = attrValue(tag, 'id') ?? attrValue(tag, 'paragraph') ?? attrValue(tag, 'index');
    const number = Number(raw);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

/** Maps an echoed numbered draft back to per-paragraph edits (repair path). */
function echoEdits(raw) {
    const bare = raw.replace(/<\/?(?:edit|delete|insert|audit)\b[^>]*>/gi, '');
    const ops = [];
    for (const match of bare.matchAll(P_PARA_RE)) {
        const body = stripEditorNoise(match[2]);
        if (body) ops.push({ type: 'edit', id: Number(match[1]), body });
    }
    return ops;
}

/**
 * Parses a surgical pass output into an ordered op list. Recognized shapes, in
 * priority order:
 *  - `<audit>PASS</audit>` → kind 'pass' (keep the draft)
 *  - `<revised_reply>`/`<final_reply>` payload → kind 'full'; a numbered draft
 *    inside the payload is mapped back into per-paragraph edits when possible
 *  - `<edit id="N">…</edit>` / `<delete id="N"/>` / `<insert after="N">…</insert>`
 *    ops → kind 'ops' (unclosed tags salvage to end-of-output)
 *  - a bare echoed numbered draft → per-paragraph edits (repair)
 *
 * @returns {{kind:'pass'}|{kind:'full',text:string}|{kind:'ops',ops:Array}|null}
 *          null when nothing actionable is present.
 */
export function parseDraftEdits(rawOutput) {
    // The PASS audit must be recognized before audit blocks are stripped.
    const fenced = stripThinkAndFence(rawOutput);
    if (!fenced) return null;
    if (/<audit>\s*PASS\s*<\/audit>/i.test(fenced)) return { kind: 'pass' };
    const raw = stripAudits(fenced);
    if (!raw) return null;

    // Escape hatch: a genuine full rewrite is accepted even in surgical mode.
    const wrapped = raw.match(/<(revised_reply|final_reply)>([\s\S]*?)<\/\1>/i);
    if (wrapped) {
        const inner = parseDraftEdits(wrapped[2]);
        if (inner?.kind === 'ops') return inner;
        if (inner?.kind === 'pass') return inner;
        return { kind: 'full', text: stripEditorNoise(wrapped[2]) };
    }

    const order = [];
    for (const kind of ['edit', 'delete', 'insert']) {
        for (const span of collectSpans(raw, kind)) order.push({ kind, span });
    }
    order.sort((a, b) => a.span.start - b.span.start);
    const ops = [];
    for (const { kind, span } of order) {
        if (kind === 'edit') {
            const id = anchorValue(span.rawTag);
            const body = span.body;
            // Repair: one <edit> wrapping the whole numbered draft becomes
            // per-paragraph edits of the echoed paragraphs.
            const nested = [...body.matchAll(P_PARA_RE)]
                .map(match => ({ type: 'edit', id: Number(match[1]), body: stripEditorNoise(match[2]) }))
                .filter(op => op.body);
            if (nested.length > 1) { ops.push(...nested); continue; }
            if (id !== null) ops.push({ type: 'edit', id, body: stripEditorNoise(body) });
        } else if (kind === 'delete') {
            const id = anchorValue(span.rawTag);
            if (id !== null) ops.push({ type: 'delete', id });
        } else {
            const after = attrValue(span.rawTag, 'after');
            const before = attrValue(span.rawTag, 'before');
            const body = stripEditorNoise(span.body);
            if (!body) continue;
            if (after === 'end' || before === 'end') ops.push({ type: 'insert', anchor: 'end', body });
            else if (after) ops.push({ type: 'insert', anchor: Number(after), body });
            else if (before) ops.push({ type: 'insert', anchor: Number(before), before: true, body });
            else {
                // <insert id="N"> → after paragraph N (0 = very front).
                const id = Number(attrValue(span.rawTag, 'id'));
                if (Number.isInteger(id)) ops.push({ type: 'insert', anchor: id, body });
            }
        }
    }
    if (ops.length) return { kind: 'ops', ops };
    // Repair: no ops at all — maybe the model just echoed the numbered draft.
    const echoed = echoEdits(raw);
    return echoed.length ? { kind: 'ops', ops: echoed } : null;
}

/**
 * Validates a parsed patch against the numbered draft: edit/delete/insert ids
 * must exist in the draft, ids may not repeat, and an empty edit body is an
 * error (use <delete> to remove a paragraph).
 *
 * @returns {string[]} issue list; empty when the patch is applicable.
 */
export function editIssues(patch, blocks) {
    const count = Array.isArray(blocks) ? blocks.length : 0;
    if (!patch) return ['The pass returned no edits, deletions or insertions.'];
    if (patch.kind === 'pass' || patch.kind === 'full') return [];
    const issues = [];
    const seen = new Set();
    for (const op of patch.ops) {
        if (op.type === 'insert' && op.anchor === 'end') continue;
        const id = op.type === 'insert' ? op.anchor : op.id;
        const valid = Number.isInteger(id) && id >= 1 && id <= count;
        if (!valid) issues.push(`Paragraph ${id ?? '(missing)'} is out of range — the draft has ${count} paragraph(s).`);
        else if (seen.has(id)) issues.push(`Paragraph ${id} is changed more than once.`);
        else if (op.type === 'edit' && !String(op.body ?? '').trim()) issues.push(`Edit for paragraph ${id} is empty.`);
        else seen.add(id);
    }
    return issues;
}

/**
 * Applies a validated patch to the numbered draft. Rebuilds the draft with its
 * original paragraph separators; an inserted paragraph inherits the draft's
 * dominant separator; a junction created by a deletion inherits the following
 * block's separator, or the dominant one when that is blank.
 *
 * @returns {string|null} the rebuilt text, or null when nothing applies.
 */
export function applyDraftEdits(patch, blocks) {
    if (!patch) return null;
    if (patch.kind === 'pass') return null;
    if (patch.kind === 'full') return patch.text || null;

    const edits = new Map();
    const deletes = new Set();
    const inserts = [];
    for (const op of patch.ops) {
        if (op.type === 'edit') edits.set(op.id, op.body);
        else if (op.type === 'delete') deletes.add(op.id);
        else inserts.push(op);
    }
    const tail = inserts.filter(op => op.anchor === 'end');
    // Slot = paragraph id the insert attaches to. 'before' inserts emit ahead of
    // their block, 'after' inserts behind it; id 0 (or after="0") is the very front.
    const bySlot = new Map();
    for (const op of inserts) {
        if (op.anchor === 'end') continue;
        if (!bySlot.has(op.anchor)) bySlot.set(op.anchor, { before: [], after: [] });
        bySlot.get(op.anchor)[op.before ? 'before' : 'after'].push(op.body);
    }

    const dominant = blocks.some(block => (block.sepBefore || '').includes('\n\n')) ? '\n\n' : '\n';
    const out = [];
    let pendingBreak = false;
    const emit = (text, sepBefore) => {
        if (!text) return;
        let sep = out.length === 0 ? '' : sepBefore;
        if (out.length > 0 && (!sep || pendingBreak)) sep = dominant;
        pendingBreak = false;
        out.push(sep ? `${sep}${text}` : text);
    };
    for (const text of bySlot.get(0)?.after ?? []) emit(text, '');
    blocks.forEach((block, index) => {
        const id = index + 1;
        const slot = bySlot.get(id);
        for (const text of slot?.before ?? []) emit(text, block.sepBefore);
        if (deletes.has(id)) { pendingBreak = true; return; }
        emit(edits.get(id) ?? block.text, block.sepBefore);
        for (const text of slot?.after ?? []) emit(text, block.sepBefore);
    });
    for (const op of tail) emit(op.body, blocks.length ? blocks[blocks.length - 1].sepBefore : '');
    return out.join('').trim() || null;
}
