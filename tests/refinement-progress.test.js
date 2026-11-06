import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refinementPhase } from '../src/refinement-checks.js';

test('refinement phases reflect output channels and exclude tags quoted in thoughts or audits', () => {
    assert.equal(refinementPhase(), 'Waiting for the provider');
    assert.equal(refinementPhase({ content: '  ' }), 'Waiting for the provider');
    assert.equal(refinementPhase({ reasoning: 'Checking continuity' }), 'Reasoning');
    assert.equal(refinementPhase({ content: '<think>Consider <edit id="1">' }), 'Reasoning');
    assert.equal(refinementPhase({ content: '<think>Consider <edit id="1"></think><audit>PASS' }), 'Audit');
    assert.equal(refinementPhase({ content: '<audit>Could use <edit id="1"> here</audit>' }), 'Audit');
    assert.equal(refinementPhase({ content: '<audit>Change needed</audit><edit id="1">New', reasoning: 'Earlier thought' }), 'Rewriting reply');
    assert.equal(refinementPhase({ content: '<audit>Change needed</audit>Revised prose' }), 'Rewriting reply');
    for (const content of ['<replace id="1">', '<delete id="1"/>', '<insert after="1">', '<revised_reply>', '<final_reply>', '```xml\n<edit id="1">New', 'Revised prose']) {
        assert.equal(refinementPhase({ content }), 'Rewriting reply', content);
    }
});
