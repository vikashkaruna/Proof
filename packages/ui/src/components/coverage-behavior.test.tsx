import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentPill } from './AgentPill';
import { AgentRunCard } from './AgentRunCard';
import { PageHeader, Stat, StatGrid } from './Layout';
import { PostureScore } from './PostureScore';
import { ProofSeal } from './ProofSeal';
import { Button } from '../primitives/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../primitives/Card';
import { Input, Label, Textarea } from '../primitives/Input';
import { ProgressBar } from '../primitives/Progress';

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('proof and status semantics', () => {
  it('reserves gold seal styling for a present hash', () => {
    const unsealed = html(<ProofSeal data-testid="proof" />);
    expect(unsealed).toContain('Unsealed');
    expect(unsealed).not.toContain('border-gold');
    const sealed = html(
      <ProofSeal hash={'a'.repeat(64)} sealedAt="2026-09-30T00:00:00Z" compact />,
    );
    expect(sealed).toContain('border-gold');
    expect(sealed).toContain('SHA-256:');
    expect(sealed).toContain('Sealed: 2026-09-30');
    expect(sealed).not.toContain('Unsealed');
  });

  it('clamps progress to accessible bounds and uses the selected semantic color', () => {
    const lower = html(<ProgressBar value={-10} showValue />);
    expect(lower).toContain('aria-valuenow="0"');
    expect(lower).toContain('width:0%');
    const upper = html(<ProgressBar value={110} variant="proof" size="lg" showValue />);
    expect(upper).toContain('aria-valuenow="100"');
    expect(upper).toContain('width:100%');
    expect(upper).toContain('bg-gold-500');
    expect(html(<ProgressBar value={60} variant="danger" />)).toContain('bg-ember-500');
    // Gold is reserved for sealed evidence, so warnings and the low-middle band use amber.
    expect(html(<ProgressBar value={60} variant="warning" />)).toContain('bg-amber-500');
    expect(html(<ProgressBar value={35} />)).toContain('bg-amber-500');
    expect(html(<ProgressBar value={35} />)).not.toContain('gold');
    expect(html(<ProgressBar value={60} variant="warning" />)).not.toContain('gold');
  });

  it('shows posture verdicts and formats positive statutory exposure', () => {
    expect(html(<PostureScore score={90} exposureInr={10_00_00_000} />)).toContain('Strong');
    expect(html(<PostureScore score={70} exposureInr={1_00_000} />)).toContain('Acceptable');
    expect(html(<PostureScore score={45} exposureInr={1_000} />)).toContain('At Risk');
    expect(html(<PostureScore score={null} exposureInr={0} />)).toContain('Critical');
    expect(html(<PostureScore score={80} variant="compact" />)).not.toContain(
      'Estimated max statutory exposure',
    );
  });

  it('renders agent state and clamps visible run progress', () => {
    const pill = html(<AgentPill agent="pramaan" state="working" />);
    expect(pill).toContain('Closure Proof');
    expect(pill).toContain('ring-1');
    expect(html(<AgentPill agent="drishti" showPersona={false} />)).not.toContain(
      'Discovery</span>',
    );
    const run = html(
      <AgentRunCard
        agent="saakshi"
        status="working"
        step="readback"
        message="Verifying"
        progress={1.5}
        actions={<button>Inspect</button>}
      />,
    );
    expect(run).toContain('readback');
    expect(run).toContain('Verifying');
    expect(run).toContain('width:100%');
    expect(run).toContain('Inspect');
  });
});

describe('input and layout accessibility', () => {
  it('disables a loading button and marks invalid input consistently', () => {
    expect(html(<Button loading>Save</Button>)).toContain('disabled');
    expect(
      html(
        <Button disabled variant="danger">
          Delete
        </Button>,
      ),
    ).toContain('bg-ember-500');
    expect(html(<Input invalid aria-label="Email" />)).toContain('border-ember-500');
    expect(html(<Textarea invalid aria-label="Description" />)).toContain('border-ember-500');
    expect(
      html(
        <Label required htmlFor="email">
          Email
        </Label>,
      ),
    ).toContain('text-ember-500');
  });

  it('renders optional page metadata and composed card structure', () => {
    const header = html(
      <PageHeader
        title="Evidence"
        description="Retained proof"
        actions={<button>Export</button>}
        meta="Reviewed"
      />,
    );
    expect(header).toContain('Retained proof');
    expect(header).toContain('Export');
    expect(header).toContain('Reviewed');
    expect(
      html(
        <StatGrid>
          <Stat label="Controls" value="10" hint="Verified" />
        </StatGrid>,
      ),
    ).toContain('Verified');
    const card = html(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Detail</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Action</CardFooter>
      </Card>,
    );
    for (const text of ['Title', 'Detail', 'Body', 'Action']) expect(card).toContain(text);
  });
});
