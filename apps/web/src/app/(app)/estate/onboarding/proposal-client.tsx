'use client';
import { useId } from 'react';
import { Card, CardHeader, CardTitle, CardContent, Input, Label } from '@axiom/ui';
import { MutationForm, type EstateRow } from '../estate-client';
interface IntakeSystem {
  name: string;
  type: string;
  description?: string;
  region?: string;
  hosts_personal_data?: boolean;
  data_categories?: string[];
}
interface ProposedSystem {
  name: string;
  systemKind: string;
  description: string;
  externalRef: string | null;
  dataCategories: string[];
}
interface Proposal {
  id: string;
  estate_id: string;
  prepared_by: string;
  estate_snapshot: EstateRow;
  source_snapshot: IntakeSystem[];
  systems: ProposedSystem[];
  content_sha256: string;
  status: 'pending' | 'approved' | 'rejected';
  review_reason: string | null;
  reviewed_by: string | null;
  onboarding_proposal_systems: { source_index: number; system_id: string }[];
}
export interface ProposalData {
  intake: IntakeSystem[];
  proposals: Proposal[];
}
const kinds = ['database', 'application', 'storage', 'identity', 'saas', 'other'];
const selectClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';
const text = (f: FormData, k: string) => String(f.get(k) ?? '');
function Mapping({ source, index }: { source: IntakeSystem; index: number }) {
  const id = useId();
  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 font-medium">
        System {index + 1}: {source.name}
      </legend>
      <details>
        <summary>Original intake</summary>
        <pre className="whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(source, null, 2)}
        </pre>
      </details>
      <Label htmlFor={`${id}-name`}>Proposed system name</Label>
      <Input
        id={`${id}-name`}
        name={`name-${index}`}
        defaultValue={source.name}
        required
        maxLength={200}
      />
      <Label htmlFor={`${id}-kind`}>Proposed system kind</Label>
      <select
        id={`${id}-kind`}
        name={`kind-${index}`}
        defaultValue={kinds.includes(source.type) ? source.type : ''}
        required
        className={selectClass}
      >
        <option value="">Choose a kind</option>
        {kinds.map((k) => (
          <option value={k} key={k}>
            {k}
          </option>
        ))}
      </select>
      <Label htmlFor={`${id}-description`}>Proposed description</Label>
      <Input
        id={`${id}-description`}
        name={`description-${index}`}
        defaultValue={source.description ?? ''}
        maxLength={4000}
      />
      <Label htmlFor={`${id}-categories`}>
        Proposed categories (comma-separated lowercase keys)
      </Label>
      <Input
        id={`${id}-categories`}
        name={`categories-${index}`}
        defaultValue={(source.data_categories ?? []).join(', ')}
        maxLength={8000}
      />
    </fieldset>
  );
}
export function ProposalClient({
  tenantId,
  userId,
  canPrepare,
  canReview,
  estates,
  data,
}: {
  tenantId: string;
  userId: string;
  canPrepare: boolean;
  canReview: boolean;
  estates: EstateRow[];
  data: ProposalData;
}) {
  const id = useId();
  const open = data.proposals.some((p) => p.status === 'pending' || p.status === 'approved');
  return (
    <>
      <p className="text-sm">
        All original intake entries are reviewed as one batch. Source region and personal-data
        declarations remain in the original snapshot; this process does not verify them or connect
        to any system.
      </p>
      {data.intake.length === 0 && (
        <p>
          No systems were submitted in the onboarding intake. Manage inventory directly from the
          estate page.
        </p>
      )}
      {canPrepare && data.intake.length > 0 && !open && (
        <Card>
          <CardHeader>
            <CardTitle>Prepare inventory proposal</CardTitle>
          </CardHeader>
          <CardContent>
            {estates.length === 0 ? (
              <p>A client owner or admin must first create the intended estate.</p>
            ) : (
              <MutationForm
                tenantId={tenantId}
                path="/onboarding/proposals"
                method="POST"
                label="Submit proposal for review"
                body={(f) => ({
                  estateId: text(f, 'estateId'),
                  systems: data.intake.map((_, i) => ({
                    name: text(f, `name-${i}`),
                    systemKind: text(f, `kind-${i}`),
                    description: text(f, `description-${i}`),
                    externalRef: null,
                    dataCategories: text(f, `categories-${i}`)
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })),
                })}
              >
                <Label htmlFor={`${id}-estate`}>Destination estate</Label>
                <select
                  id={`${id}-estate`}
                  name="estateId"
                  defaultValue=""
                  required
                  className={selectClass}
                >
                  <option value="">Choose the assessment boundary</option>
                  {estates.map((e) => (
                    <option value={e.id} key={e.id}>
                      {e.name} ({e.slug})
                    </option>
                  ))}
                </select>
                {data.intake.map((source, index) => (
                  <Mapping key={index} source={source} index={index} />
                ))}
                <label className="flex gap-2 text-sm">
                  <input type="checkbox" required /> I reviewed every mapping against the original
                  intake.
                </label>
              </MutationForm>
            )}
          </CardContent>
        </Card>
      )}
      {data.proposals.length === 0 && data.intake.length > 0 && !canPrepare && (
        <p>No proposal is ready yet. An assigned Axiom analyst can prepare it.</p>
      )}
      {data.proposals.map((p) => (
        <Card key={`${p.id}:${p.status}`}>
          <CardHeader>
            <CardTitle>
              {p.estate_snapshot.name} — {p.status}
            </CardTitle>
            <p className="text-sm">
              Prepared by {p.prepared_by}. Estate version {p.estate_snapshot.version}.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>{p.estate_snapshot.description}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="font-medium">Original intake</h3>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(p.source_snapshot, null, 2)}
                </pre>
              </div>
              <div>
                <h3 className="font-medium">Proposed inventory</h3>
                <ol className="space-y-3">
                  {p.systems.map((system, index) => (
                    <li key={index}>
                      <strong>{system.name}</strong> · {system.systemKind}
                      <p>{system.description}</p>
                      <p>Declared categories: {system.dataCategories.join(', ') || 'None'}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            {p.review_reason && (
              <p>
                Review by {p.reviewed_by}: {p.review_reason}
              </p>
            )}
            {p.status === 'approved' && (
              <p>
                {p.onboarding_proposal_systems.length} systems added. Original source-to-system
                links are retained.
              </p>
            )}
            {p.status === 'pending' && canReview && p.prepared_by !== userId && (
              <Review tenantId={tenantId} proposal={p} />
            )}
            {p.status === 'pending' && (!canReview || p.prepared_by === userId) && (
              <p>Awaiting review by a different client owner or admin.</p>
            )}
          </CardContent>
        </Card>
      ))}
    </>
  );
}
function Review({ tenantId, proposal }: { tenantId: string; proposal: Proposal }) {
  const id = useId();
  return (
    <MutationForm
      tenantId={tenantId}
      path={`/onboarding/proposals/${proposal.id}/review`}
      method="POST"
      label="Record review"
      body={(f) => ({
        contentSha256: proposal.content_sha256,
        decision: text(f, 'decision'),
        reason: text(f, 'reason'),
      })}
    >
      <Label htmlFor={`${id}-decision`}>Review decision</Label>
      <select
        id={`${id}-decision`}
        name="decision"
        defaultValue=""
        required
        className={selectClass}
      >
        <option value="">Choose a decision</option>
        <option value="approved">Approve and add systems</option>
        <option value="rejected">Reject for revision</option>
      </select>
      <Label htmlFor={`${id}-reason`}>Review reason</Label>
      <Input id={`${id}-reason`} name="reason" required maxLength={2000} />
      <label className="flex gap-2 text-sm">
        <input type="checkbox" required /> I reviewed the estate, original intake and every proposed
        system.
      </label>
    </MutationForm>
  );
}
