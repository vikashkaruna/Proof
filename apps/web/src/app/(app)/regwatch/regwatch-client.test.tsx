import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import RegWatchPage from './page';

it('fails closed when no authoritative regulatory feed is connected', async () => {
  const html = renderToStaticMarkup(await RegWatchPage());
  expect(html).toContain('No verified regulatory feed is connected');
  expect(html).toContain('source citations');
  expect(html).toContain('official authority publications');
  expect(html).not.toContain('Run Live Gazette Scan');
  expect(html).not.toContain('Feeds Synchronized');
  expect(html).not.toContain('zero statutory drift');
  expect(html).not.toContain('13 May 2027');
  expect(html).not.toContain('INTEL-2026');
});
