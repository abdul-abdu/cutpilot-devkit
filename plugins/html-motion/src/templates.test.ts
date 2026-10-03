/** The templates as data and HTML: pure, no browser. */
import { ListTemplatesOutputSchema } from '@cutpilot/plugin-sdk';
import { describe, expect, test } from 'vitest';
import { compose, describeTemplate, esc, fit, shade, TEMPLATES, templateById } from './templates.js';

const frame = { width: 1080, height: 1920, fps: 30, durationMs: 3000 };

describe('templates', () => {
  test('nine templates, listed as the generator contract says', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'title-card',
      'chapter',
      'quote',
      'bullets',
      'end-card',
      'hook',
      'offer',
      'stat',
      'social-proof',
    ]);
    const listed = ListTemplatesOutputSchema.parse({ templates: TEMPLATES.map(describeTemplate) });
    for (const t of listed.templates) {
      expect(t.params).toMatchObject({ type: 'object' });
      expect(t.aspects).toEqual([]);
    }
    // the JSON Schema says what is required and what has a default
    const title = listed.templates[0]!.params as {
      required: string[];
      properties: Record<string, { default?: unknown }>;
    };
    expect(title.required).toEqual(['title']);
    expect(title.properties.background?.default).toBe('#0f172a');
  });

  test('each example is valid for its own schema, and its defaults fill in the colours', () => {
    for (const t of TEMPLATES) {
      const p = t.params.parse(t.example);
      expect(p).toMatchObject({ background: '#0f172a', color: '#ffffff', accent: '#ffd400' });
    }
  });

  test('parameters are checked: required text, lengths, list sizes, colours', () => {
    const problems = (id: string, params: unknown) =>
      templateById(id)!
        .params.safeParse(params)
        .error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(problems('title-card', {})).toEqual(['title: Invalid input: expected string, received undefined']);
    expect(problems('title-card', { title: '   ' })).toEqual([
      'title: Too small: expected string to have >=1 characters',
    ]);
    expect(problems('bullets', { items: [] })).toEqual([
      'items: Too small: expected array to have >=1 items',
    ]);
    expect(problems('bullets', { items: ['a', 'b', 'c', 'd', 'e', 'f'] })).toEqual([
      'items: Too big: expected array to have <=5 items',
    ]);
    expect(problems('quote', { text: 'x', accent: 'red' })).toEqual(['accent: colours look like #RRGGBB']);
  });

  test('a composition HyperFrames can render: root size, fps, length, a paused timeline', () => {
    const t = templateById('title-card')!;
    const { html, durationMs } = compose(t, t.params.parse(t.example), frame, 'vendor/gsap.min.js');
    expect(durationMs).toBe(3000);
    expect(html).toContain(
      'data-composition-id="main" data-start="0" data-duration="3" data-width="1080" data-height="1920" data-fps="30"',
    );
    expect(html).toContain('<script src="vendor/gsap.min.js"></script>');
    expect(html).toContain('gsap.timeline({ paused: true })');
    expect(html).toContain('window.__timelines.main = tl;');
    // the card fades out over the last 0.4 s
    expect(html).toContain('tl.to("#card", { opacity: 0, duration: 0.4, ease: "power1.in" }, 2.6);');
  });

  test('text is escaped, never markup', () => {
    const t = templateById('quote')!;
    const { html } = compose(
      t,
      t.params.parse({ text: '<script>alert(1)</script> & "you"', author: "O'Brien" }),
      frame,
      'g.js',
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('— O&#39;Brien');
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  test('the quote comes in word by word, finishing by 45% of the clip', () => {
    const t = templateById('quote')!;
    const text = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const { html } = compose(t, t.params.parse({ text }), { ...frame, durationMs: 6000 }, 'g.js');
    expect(html.match(/<span id="w\d+">/g)).toHaveLength(30);
    expect(html).toContain('stagger: 0.09 }'); // 6 s × 0.45 / 30 words
  });

  test('the end card pulses its button only when there is time, and never past the fade', () => {
    const t = templateById('end-card')!;
    const pulse = (durationMs: number) =>
      /repeat: (\d+)/.exec(compose(t, t.params.parse(t.example), { ...frame, durationMs }, 'g.js').html)?.[1];
    expect(pulse(1500)).toBeUndefined();
    expect(pulse(4000)).toBe('9'); // (3.6 − 1.1) / 0.5 = 5 pulses, up and down
  });

  test('text shrinks as it gets longer, never below its minimum', () => {
    expect(fit('Short', 120, 50)).toBe(120);
    expect(fit('x'.repeat(72), 120, 50)).toBe(60);
    expect(fit('x'.repeat(1000), 120, 50)).toBe(50);
  });

  test('shade mixes towards white or black', () => {
    expect(shade('#000000', 0.5)).toBe('#808080');
    expect(shade('#ffffff', -1)).toBe('#000000');
    expect(shade('#0f172a', 0)).toBe('#0f172a');
  });

  test('portrait frames get larger text than the short side alone gives', () => {
    const t = templateById('title-card')!;
    const size = (w: number, h: number) =>
      Number(
        /#title \{ margin: 0; font-size: (\d+)px/.exec(
          compose(t, t.params.parse(t.example), { ...frame, width: w, height: h }, 'g.js').html,
        )?.[1],
      );
    expect(size(1080, 1920)).toBeGreaterThan(size(1920, 1080));
  });
});

describe('the ad templates (AD1-060)', () => {
  const html = (id: string, params: Record<string, unknown>, over: Partial<typeof frame> = {}) => {
    const t = templateById(id)!;
    return compose(t, t.params.parse(params), { ...frame, ...over }, 'g.js').html;
  };

  test('hook: the highlight is accented inside the escaped line; without one the line is plain', () => {
    const h = html('hook', { text: 'Still editing <by hand>?', highlight: '<by hand>' });
    expect(h).toContain('Still editing <span id="hl">&lt;by hand&gt;</span>?');
    expect(html('hook', { text: 'Fast cuts' })).not.toContain('id="hl"');
    // a highlight that is not part of the line is ignored, not shown twice
    expect(html('hook', { text: 'Fast cuts', highlight: 'slow' })).not.toContain('id="hl"');
  });

  test('offer: badge, offer, line and code in order; the badge pulses on long clips, not short ones', () => {
    const t = templateById('offer')!;
    const long = html('offer', t.example as Record<string, unknown>, { durationMs: 4000 });
    for (const bit of ['id="badge"', 'id="offer"', 'id="line"', 'id="code"']) expect(long).toContain(bit);
    expect(long).toMatch(/tl\.to\("#badge", \{ scale: 1\.08.*repeat: \d+/);
    const short = html('offer', { offer: '-20%' }, { durationMs: 1500 });
    expect(short).not.toContain('id="badge"');
    expect(short).not.toContain('tl.to("#badge"');
  });

  test('stat: starts at 0 and counts up to the value with whole-number snapping', () => {
    const h = html('stat', { value: 12000, suffix: '+', label: 'creators' });
    expect(h).toContain('<span id="num">0</span>');
    expect(h).toContain('tl.to("#num", { innerText: 12000,');
    expect(h).toContain('snap: { innerText: 1 }');
    expect(h).toContain('<span id="suf">+</span>');
  });

  test('social-proof: as many stars as the rating, the quote in quotation marks', () => {
    const h = html('social-proof', { quote: 'Sundays back.', rating: 4 });
    expect(h.match(/class="st"/g)).toHaveLength(4);
    expect(h).toContain('\u201CSundays back.\u201D');
    expect(h).not.toContain('id="name"');
    const bad = templateById('social-proof')!.params.safeParse({ quote: 'x', rating: 6 });
    expect(bad.success).toBe(false);
  });
});
