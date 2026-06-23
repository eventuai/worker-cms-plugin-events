import { describe, expect, it } from 'vitest';
import { mjmlToHtml, parseMjml } from '../src/mjml';

const DOC = `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text padding="0 25px" color="#222222" font-size="15px" font-family="Arial" />
      <mj-button background-color="#4f46e5" color="#ffffff" />
      <mj-class name="headline" font-size="24px" padding="0 25px 28px 25px" />
    </mj-attributes>
    <mj-preview>Preview line</mj-preview>
    <mj-style>p { margin-top:0; }</mj-style>
  </mj-head>
  <mj-body background-color="#eeeeee" width="600">
    <mj-section background-color="#ffffff">
      <mj-column>
        <mj-text mj-class="headline">You're invited</mj-text>
        <mj-text><p>Body <strong>copy</strong>.</p></mj-text>
        <mj-image src="https://x.io/a.png" width="200" align="center" />
        <mj-button href="https://x.io/rsvp">RSVP</mj-button>
        <mj-table><tr><td>Date</td><td>1 Jan</td></tr></mj-table>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

describe('mjml compiler', () => {
  it('keeps raw inner HTML for content tags when parsing', () => {
    const root = parseMjml('<mj-text><p>Hi &amp; bye</p></mj-text>');
    expect(root.children[0].tag).toBe('mj-text');
    expect(root.children[0].raw).toBe('<p>Hi &amp; bye</p>');
  });

  it('compiles to email HTML with no MJML tags left', () => {
    const html = mjmlToHtml(DOC);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<mj-|<mjml/);
  });

  it('applies head defaults and mj-class attributes', () => {
    const html = mjmlToHtml(DOC);
    expect(html).toContain('color:#222222'); // mj-text default colour
    expect(html).toContain('font-size:24px'); // headline class
    expect(html).toContain('background-color:#4f46e5'); // button default
  });

  it('renders each component and preserves inner HTML', () => {
    const html = mjmlToHtml(DOC);
    expect(html).toContain("You're invited");
    expect(html).toContain('<p>Body <strong>copy</strong>.</p>');
    expect(html).toContain('src="https://x.io/a.png"');
    expect(html).toContain('href="https://x.io/rsvp"');
    expect(html).toContain('<td>Date</td><td>1 Jan</td>');
    expect(html).toContain('Preview line');
    expect(html).toContain('p { margin-top:0; }');
  });

  it('honours the body background colour and width', () => {
    const html = mjmlToHtml(DOC);
    expect(html).toContain('#eeeeee');
    expect(html).toContain('width="600"');
  });
});
